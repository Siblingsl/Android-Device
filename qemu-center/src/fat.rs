//! Zero-dependency **FAT16 image builder** for the cloud-init NoCloud seed
//! disk, plus the (test-side) reader that proves the image is consistent.
//!
//! # Why a hand-written FAT16 image
//!
//! The seed carrier walked through three designs; the first two were
//! **falsified on the user's real WHPX host (node1)** and only the third is
//! validated end-to-end:
//!
//! 1. **Self-built ISO9660** (`crate::iso`) — the spec stores directory-record
//!    names uppercase (`USER-DATA.;1`); the guest's cloud-init needs the exact
//!    lowercase `user-data` and silently ignored the seed (public-key auth
//!    refused). Retired to a library API / test asset.
//! 2. **QEMU VVFAT** (`-drive file=fat:<dir>`) — presents the host directory
//!    as a FAT disk, but **vvfat hard-wires the volume label to `QEMU VVFAT`
//!    and it is not configurable**. cloud-init's `ds-identify` scans block
//!    devices for `LABEL=cidata` in the init-local stage, so the datasource
//!    check failed and cloud-init never activated at all (guest console:
//!    zero cloud-init log lines, `systemd-networkd-wait-online` hanging).
//! 3. **This module**: a bare FAT16 volume with the volume label `CIDATA` and
//!    VFAT long-file-name entries storing the seed names verbatim in
//!    lowercase, attached as an ordinary read-only virtio disk. Validated on
//!    the same machine: `cloud-init status=done`, Docker active, SSH
//!    public-key auth OK. `blkid` reports `LABEL="CIDATA" TYPE="vfat"` because
//!    the volume carries no partition table — the raw FAT boot sector is what
//!    blkid/ds-identify read.
//!
//! # Layout (fixed, 64 MiB)
//!
//! | region | sectors | bytes | notes |
//! |---|---|---|---|
//! | reserved (BPB) | 4 | 2048 | boot sector; jump stub is inert (data disk) |
//! | FAT #1 | 128 | 65536 | `sectors_per_fat` from the fixed point below |
//! | FAT #2 | 128 | 65536 | byte-identical copy (the `num_fats=2` contract) |
//! | root directory | 32 | 16384 | 512 × 32-byte entries, FAT16 = fixed size |
//! | data area | 32680 | 66953216 | 2 KiB clusters, chain-allocated in file order |
//!
//! `sectors_per_fat` is **not** guessed: starting from the 256-sector estimate
//! the pair `fat_sectors = ceil((clusters + 2) * 2 / 512)` /
//! `clusters = (total - reserved - 2 * fat_sectors - root_dir_sectors) / 4` is
//! iterated to a fixed point **at compile time** ([`FAT_SECTORS`] /
//! [`CLUSTER_COUNT`]), so the BPB can never describe a FAT that is too small
//! for the cluster count it advertises. `total_sectors_16` holds 0 and the real
//! count lives in `total_sectors_32` (131072 does not fit in 16 bits — this is
//! exactly what `mkfs.vfat` does for a 64 MiB volume, and what the Linux FAT
//! driver expects to read).
//!
//! The builder is a **pure function**: byte-identical output for identical
//! input. mkfs.vfat derives the volume id and all timestamps from the clock;
//! here they are fixed constants ([`VOLUME_ID`], [`FIXED_DOS_DATE`]) — nothing
//! that reads a FAT volume (blkid, cloud-init, the kernel) looks at either.

use std::collections::BTreeSet;

/// Total size of a generated seed image: 64 MiB, matching the hand-validated
/// reference image (`mkfs.vfat` + `mcopy`) that was proven on the user's host.
pub const SEED_IMAGE_BYTES: usize = 64 * 1024 * 1024;

/// The BPB volume label field, exactly 11 bytes (space padded).
pub const VOLUME_LABEL_11: [u8; 11] = *b"CIDATA     ";

const BYTES_PER_SECTOR: u32 = 512;
const SECTORS_PER_CLUSTER: u32 = 4;
const CLUSTER_BYTES: usize = (BYTES_PER_SECTOR * SECTORS_PER_CLUSTER) as usize;
/// Reserved sectors before FAT #1. 1 would be the minimum; 4 is mkfs.fat's
/// default for FAT16 and therefore the exact geometry of the machine-validated
/// reference image (see the module docs). With 4 the data area divides evenly:
/// (131072 - 4 - 2*128 - 32) / 4 = 32695 clusters, no truncation slack.
const RESERVED_SECTORS: u32 = 4;
const NUM_FATS: u32 = 2;
const ROOT_ENTRIES: u32 = 512;
const ROOT_DIR_BYTES: u32 = ROOT_ENTRIES * 32;
const ROOT_DIR_SECTORS: u32 = ROOT_DIR_BYTES / BYTES_PER_SECTOR;
const TOTAL_SECTORS: u32 = (SEED_IMAGE_BYTES as u32) / BYTES_PER_SECTOR;
const MEDIA_DESCRIPTOR: u8 = 0xF8;
/// CHS geometry mkfs.fat derives for the 64 MiB reference image:
/// 131072 sectors = 512 cylinders × 8 heads × 32 sectors. Inert for a raw
/// virtio disk (Linux addresses by LBA), kept for byte-parity with the
/// machine-validated artifact.
const SECTORS_PER_TRACK: u16 = 32;
const HEADS: u16 = 8;
const DRIVE_NUMBER: u8 = 0x80;
const EXTENDED_BOOT_SIG: u8 = 0x29;
const OEM_NAME_8: [u8; 8] = *b"MSDOS5.0";
const FS_TYPE_8: [u8; 8] = *b"FAT16   ";

/// Fixed volume id (offset 0x27). mkfs.vfat uses a clock-derived value; a pure
/// builder must not, and no reader of a seed volume consumes it.
const VOLUME_ID: u32 = 0x0000_0001;
/// Fixed DOS timestamp for every entry: 2026-01-01 00:00:00 — deterministic,
/// and (unlike zeros) a *valid* DOS date so guest-side listings are sane.
const FIXED_DOS_DATE: u16 = ((2026 - 1980) << 9) | (1 << 5) | 1;
const FIXED_DOS_TIME: u16 = 0;

const FAT_ENTRY_EOC: u16 = 0xFFFF;
/// FAT[0] = 0xFF00 | media descriptor (0xFFF8 for a fixed disk 0xF8).
const FAT_ENTRY_MEDIA: u16 = 0xFF00 | MEDIA_DESCRIPTOR as u16;
/// First data cluster (FAT reserves 0 = media, 1 = end-of-chain marker).
const FIRST_DATA_CLUSTER: u32 = 2;

/// Compile-time fixed point for `sectors_per_fat`: start from the 256-sector
/// estimate and iterate until the value is self-consistent with the cluster
/// count it leaves room for.
const fn converge_fat_sectors() -> u32 {
    let mut fat_sectors: u32 = 256;
    loop {
        let data_sectors =
            TOTAL_SECTORS - RESERVED_SECTORS - NUM_FATS * fat_sectors - ROOT_DIR_SECTORS;
        let clusters = data_sectors / SECTORS_PER_CLUSTER;
        // Each cluster costs one 16-bit FAT entry; clusters 0 and 1 exist too.
        let needed = ((clusters + 2) * 2 + BYTES_PER_SECTOR - 1) / BYTES_PER_SECTOR;
        if needed == fat_sectors {
            return fat_sectors;
        }
        fat_sectors = needed;
    }
}

/// Sectors per FAT copy (converged: 128 for the 64 MiB layout).
pub const FAT_SECTORS: u32 = converge_fat_sectors();
/// Addressable data clusters (converged: 32695). Valid cluster ids are
/// `2..=CLUSTER_COUNT + 1`.
pub const CLUSTER_COUNT: u32 =
    (TOTAL_SECTORS - RESERVED_SECTORS - NUM_FATS * FAT_SECTORS - ROOT_DIR_SECTORS)
        / SECTORS_PER_CLUSTER;

const FAT_START: usize = (RESERVED_SECTORS * BYTES_PER_SECTOR) as usize;
const FAT_BYTES: usize = (FAT_SECTORS * BYTES_PER_SECTOR) as usize;
const ROOT_DIR_START: usize =
    ((RESERVED_SECTORS + NUM_FATS * FAT_SECTORS) * BYTES_PER_SECTOR) as usize;
const DATA_START: usize = ROOT_DIR_START + ROOT_DIR_BYTES as usize;

/// Characters the 8.3 algorithm must not carry over (replaced with `_`).
/// Space is *removed* rather than replaced, per the Microsoft vfat rules, so
/// it is not listed here. `.` is here because it is the separator: any dot
/// left inside a chunk is illegal.
const ILLEGAL_SHORT_CHARS: &str = "\"*+,./:;<=>?[\\]|";

fn put_u16(buf: &mut [u8], off: usize, v: u16) {
    buf[off..off + 2].copy_from_slice(&v.to_le_bytes());
}

fn put_u32(buf: &mut [u8], off: usize, v: u32) {
    buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
}

/// The 13th slot layout of an LFN entry: 5 units at 0x01, 6 at 0x0E, 2 at 0x1C.
fn lfn_slot_pos(k: usize) -> usize {
    if k < 5 {
        1 + k * 2
    } else if k < 11 {
        14 + (k - 5) * 2
    } else {
        28 + (k - 11) * 2
    }
}

/// The VFAT long-file-name checksum over the 11 bytes of the 8.3 short name.
/// (`sum = ((sum >> 1) | ((sum & 1) << 7)) + byte`, truncated to 8 bits.)
fn lfn_checksum(short: &[u8; 11]) -> u8 {
    let mut sum: u8 = 0;
    for &b in short {
        sum = sum.rotate_right(1).wrapping_add(b);
    }
    sum
}

/// The LFN entry chain for one long name, **in on-disk order**: descending
/// ordinal, the highest carrying the 0x40 terminator flag, immediately
/// followed by the 8.3 entry by the caller.
fn lfn_entries(long: &str, checksum: u8) -> Result<Vec<[u8; 32]>, String> {
    if long.contains('\0') || long.contains('/') {
        return Err(format!("file name {long:?} contains a path/illegal character"));
    }
    let units: Vec<u16> = long.encode_utf16().collect();
    if units.is_empty() {
        return Err("file name must not be empty".to_string());
    }
    if units.len() > 255 {
        return Err(format!(
            "file name {long:?} is {} UTF-16 units; the VFAT LFN limit is 255",
            units.len()
        ));
    }
    let count = units.len().div_ceil(13);
    let mut out = Vec::with_capacity(count);
    for seq in (1..=count).rev() {
        let mut e = [0u8; 32];
        e[0] = if seq == count {
            0x40 | seq as u8
        } else {
            seq as u8
        };
        e[11] = 0x0F; // ATTR_LONG_NAME (READ_ONLY | HIDDEN | SYSTEM | VOLUME_ID)
        e[12] = 0x00; // LFN type marker, must be zero
        e[13] = checksum;
        for k in 0..13 {
            let g = (seq - 1) * 13 + k;
            // A name that exactly fills the chain carries no terminator (the
            // ordinal count delimits it); otherwise 0x0000 ends it and 0xFFFF
            // pads the remaining slots.
            let unit = match units.get(g) {
                Some(&u) => u,
                None if g == units.len() => 0x0000,
                None => 0xFFFF,
            };
            let p = lfn_slot_pos(k);
            e[p] = unit as u8;
            e[p + 1] = (unit >> 8) as u8;
        }
        out.push(e);
    }
    Ok(out)
}

fn pack_short(base: &str, ext: &str) -> [u8; 11] {
    let mut out = [b' '; 11];
    for (i, b) in base.bytes().take(8).enumerate() {
        out[i] = b;
    }
    for (i, b) in ext.bytes().take(3).enumerate() {
        out[8 + i] = b;
    }
    out
}

/// Uppercase one 8.3 chunk. Returns the sanitized text, whether anything had
/// to be replaced/removed (which makes the short name *lossy* and therefore
/// forces a `~N` tail), and whether the long name held lowercase there (the
/// NT flag byte 0x08/0x10 records that, as Linux vfat does).
fn sanitize_chunk(s: &str) -> (String, bool, bool) {
    let mut out = String::new();
    let mut lossy = false;
    let mut had_lower = false;
    for c in s.chars() {
        if c == ' ' {
            lossy = true;
            continue;
        }
        if c.is_ascii_lowercase() {
            had_lower = true;
            out.push(c.to_ascii_uppercase());
        } else if c.is_ascii_uppercase()
            || c.is_ascii_digit()
            || (c.is_ascii_punctuation() && !ILLEGAL_SHORT_CHARS.contains(c))
        {
            out.push(c);
        } else {
            // Control chars, non-ASCII (no OEM code page here) and the
            // path-ish punctuation set all collapse to `_`.
            out.push('_');
            lossy = true;
        }
    }
    (out, lossy, had_lower)
}

struct ShortName {
    bytes: [u8; 11],
    /// NT case flags (0x08 = base lowercase, 0x10 = ext lowercase). Only
    /// meaningful when a reader ignores the LFN entries; harmless otherwise.
    nt_flags: u8,
}

/// Derive a collision-free 8.3 name from a long name (Microsoft algorithm):
/// split at the last dot, uppercase + filter both chunks, and when the result
/// does not fit 8.3 (or had to be altered) truncate the base and append
/// `~N`, shrinking the base as the tail grows.
fn derive_short_name(
    long: &str,
    used: &mut BTreeSet<[u8; 11]>,
) -> Result<ShortName, String> {
    let (raw_base, raw_ext) = match long.rfind('.') {
        Some(i) if i + 1 < long.len() => (&long[..i], &long[i + 1..]),
        _ => (long, ""),
    };
    let (base, base_lossy, base_lower) = sanitize_chunk(raw_base);
    let (ext, ext_lossy, ext_lower) = sanitize_chunk(raw_ext);
    if base.is_empty() && ext.is_empty() {
        return Err(format!(
            "file name {long:?} has no characters usable in an 8.3 short name"
        ));
    }
    let mut lossy = base_lossy || ext_lossy;
    if base.chars().count() > 8 || ext.chars().count() > 3 {
        lossy = true;
    }
    let mut nt_flags = 0u8;
    if base_lower {
        nt_flags |= 0x08;
    }
    if ext_lower {
        nt_flags |= 0x10;
    }

    if !lossy {
        let candidate = pack_short(&base, &ext);
        if !used.contains(&candidate) {
            used.insert(candidate);
            return Ok(ShortName {
                bytes: candidate,
                nt_flags,
            });
        }
    }

    let ext3: String = ext.chars().take(3).collect();
    let mut tail: u32 = 1;
    loop {
        let digits = tail.to_string().len();
        if digits > 6 {
            return Err(format!("cannot derive a unique 8.3 short name for {long:?}"));
        }
        // base + '~' + digits must fit the 8-byte base field.
        let take = 6.min(8usize.saturating_sub(1 + digits));
        let truncated: String = base.chars().take(take).collect();
        let candidate = pack_short(&format!("{truncated}~{tail}"), &ext3);
        if !used.contains(&candidate) {
            used.insert(candidate);
            return Ok(ShortName {
                bytes: candidate,
                nt_flags,
            });
        }
        tail += 1;
    }
}

fn write_boot_sector(img: &mut [u8]) {
    // `jmp short +0x3C` / `nop`: an inert stub — this is a data volume, never
    // booted, but the byte pattern is what every FAT writer emits.
    img[0] = 0xEB;
    img[1] = 0x3C;
    img[2] = 0x90;
    img[3..11].copy_from_slice(&OEM_NAME_8);
    put_u16(img, 0x0B, BYTES_PER_SECTOR as u16);
    img[0x0D] = SECTORS_PER_CLUSTER as u8;
    put_u16(img, 0x0E, RESERVED_SECTORS as u16);
    img[0x10] = NUM_FATS as u8;
    put_u16(img, 0x11, ROOT_ENTRIES as u16);
    // 131072 sectors do not fit 16 bits: 0 here + the 32-bit field below.
    put_u16(img, 0x13, 0);
    img[0x15] = MEDIA_DESCRIPTOR;
    put_u16(img, 0x16, FAT_SECTORS as u16);
    put_u16(img, 0x18, SECTORS_PER_TRACK);
    put_u16(img, 0x1A, HEADS);
    put_u32(img, 0x1C, 0); // hidden sectors: no partition table, LBA 0 is the VBR
    put_u32(img, 0x20, TOTAL_SECTORS);
    img[0x24] = DRIVE_NUMBER;
    img[0x25] = 0; // reserved
    img[0x26] = EXTENDED_BOOT_SIG;
    put_u32(img, 0x27, VOLUME_ID);
    img[0x2B..0x36].copy_from_slice(&VOLUME_LABEL_11);
    img[0x36..0x3E].copy_from_slice(&FS_TYPE_8);
    img[0x1FE] = 0x55;
    img[0x1FF] = 0xAA;
}

/// Write one FAT entry into **both** FAT copies (they must stay identical).
fn put_fat_entry(img: &mut [u8], idx: u32, value: u16) {
    let off = FAT_START + idx as usize * 2;
    put_u16(img, off, value);
    put_u16(img, off + FAT_BYTES, value);
}

/// Build the complete seed image: a bare FAT16 volume, volume label `CIDATA`,
/// `files` stored under their exact names via VFAT long-file-name entries.
///
/// Files are chain-allocated in the given order starting at cluster 2 and the
/// data area holds each file contiguously; empty files get cluster 0 and size
/// 0 (still with LFN entries, so their lowercase names survive).
pub fn build_fat16_image(files: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut img = vec![0u8; SEED_IMAGE_BYTES];
    write_boot_sector(&mut img);
    put_fat_entry(&mut img, 0, FAT_ENTRY_MEDIA);
    put_fat_entry(&mut img, 1, FAT_ENTRY_EOC);

    // Root directory slot 0: the volume label entry (attr 0x08). blkid reads
    // the label from the BPB, but a mount shows the root-dir entry too — both
    // must say CIDATA for `lsblk -o LABEL` / `blkid` / ds-identify agreement.
    let mut label_entry = [0u8; 32];
    label_entry[..11].copy_from_slice(&VOLUME_LABEL_11);
    label_entry[11] = 0x08;
    img[ROOT_DIR_START..ROOT_DIR_START + 32].copy_from_slice(&label_entry);

    let mut used_short: BTreeSet<[u8; 11]> = BTreeSet::new();
    let mut root_slot: u32 = 1;
    let mut next_cluster = FIRST_DATA_CLUSTER;

    for (name, bytes) in files {
        let short = derive_short_name(name, &mut used_short)?;
        let lfn = lfn_entries(name, lfn_checksum(&short.bytes))?;
        if root_slot + 1 + lfn.len() as u32 > ROOT_ENTRIES {
            return Err(format!(
                "root directory full: {ROOT_ENTRIES} entries, cannot add {name:?}"
            ));
        }

        let slot_off = |slot: u32| ROOT_DIR_START + slot as usize * 32;
        for e in &lfn {
            let off = slot_off(root_slot);
            img[off..off + 32].copy_from_slice(e);
            root_slot += 1;
        }

        // Cluster chain (empty files: no chain at all, first cluster 0).
        let mut first_cluster: u16 = 0;
        if !bytes.is_empty() {
            let n = bytes.len().div_ceil(CLUSTER_BYTES) as u32;
            if next_cluster + n > CLUSTER_COUNT + FIRST_DATA_CLUSTER {
                return Err(format!(
                    "seed data area exhausted: {} bytes free, {name:?} needs {}",
                    (CLUSTER_COUNT + FIRST_DATA_CLUSTER - next_cluster) as usize * CLUSTER_BYTES,
                    bytes.len()
                ));
            }
            first_cluster = next_cluster as u16;
            for i in 0..n {
                let c = next_cluster + i;
                put_fat_entry(&mut img, c, if i + 1 == n { FAT_ENTRY_EOC } else { (c + 1) as u16 });
                let src = i as usize * CLUSTER_BYTES;
                let end = (src + CLUSTER_BYTES).min(bytes.len());
                let dst = DATA_START + (c as usize - FIRST_DATA_CLUSTER as usize) * CLUSTER_BYTES;
                img[dst..dst + (end - src)].copy_from_slice(&bytes[src..end]);
            }
            next_cluster += n;
        }

        // The 8.3 entry that terminates the LFN chain.
        let mut e = [0u8; 32];
        e[..11].copy_from_slice(&short.bytes);
        e[11] = 0x20; // archive
        e[12] = short.nt_flags;
        put_u16(&mut e, 0x10, FIXED_DOS_DATE); // creation date
        put_u16(&mut e, 0x12, FIXED_DOS_DATE); // last access date
        put_u16(&mut e, 0x16, FIXED_DOS_TIME); // write time
        put_u16(&mut e, 0x18, FIXED_DOS_DATE); // write date
        put_u16(&mut e, 0x1A, first_cluster); // FAT16: no high cluster word
        put_u32(&mut e, 0x1C, bytes.len() as u32);
        let off = slot_off(root_slot);
        img[off..off + 32].copy_from_slice(&e);
        root_slot += 1;
    }

    Ok(img)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_u16(buf: &[u8], off: usize) -> u16 {
        u16::from_le_bytes([buf[off], buf[off + 1]])
    }

    fn read_u32(buf: &[u8], off: usize) -> u32 {
        u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
    }

    fn three_files() -> Vec<(String, Vec<u8>)> {
        vec![
            (
                "user-data".to_string(),
                b"#cloud-config\nhostname: qc-node-1\nusers:\n  - name: rdc\n".to_vec(),
            ),
            (
                "meta-data".to_string(),
                b"instance-id: iid-qemu-center-qc-node-1\nlocal-hostname: qc-node-1\n".to_vec(),
            ),
            (
                "network-config".to_string(),
                b"version: 2\nethernets:\n  all-eth:\n    dhcp4: true\n".to_vec(),
            ),
        ]
    }

    fn short_name_str(s: &[u8; 11]) -> String {
        let base = String::from_utf8_lossy(&s[..8]).trim_end().to_string();
        let ext = String::from_utf8_lossy(&s[8..]).trim_end().to_string();
        if ext.is_empty() {
            base
        } else {
            format!("{base}.{ext}")
        }
    }

    // ---- an independent reader: BPB → root dir → FAT chain, like a kernel --

    struct ParsedFile {
        lfn: Option<String>,
        short: [u8; 11],
        nt_flags: u8,
        first_cluster: u16,
        size: u32,
        data: Vec<u8>,
    }

    struct Parsed {
        label: String,
        entries: Vec<ParsedFile>,
    }

    fn parse(img: &[u8]) -> Parsed {
        let bps = read_u16(img, 0x0B) as usize;
        let spc = img[0x0D] as usize;
        let reserved = read_u16(img, 0x0E) as usize;
        let nfats = img[0x10] as usize;
        let root_entries = read_u16(img, 0x11) as usize;
        let spf = read_u16(img, 0x16) as usize;
        let fat_start = reserved * bps;
        let root_start = (reserved + nfats * spf) * bps;
        let data_start = root_start + root_entries * 32;
        let cluster_bytes = spc * bps;
        let fat_entry = |idx: u32| read_u16(img, fat_start + idx as usize * 2);
        let cluster = |idx: u32| {
            let off = data_start + (idx as usize - 2) * cluster_bytes;
            &img[off..off + cluster_bytes]
        };
        let read_chain = |first: u32, size: usize| -> Vec<u8> {
            let mut out = Vec::with_capacity(size);
            let mut c = first;
            // Guard: the chain must terminate (EOC) before the image runs out.
            while c >= 2 && out.len() < size {
                out.extend_from_slice(cluster(c));
                let next = fat_entry(c) as u32;
                assert!(next == 0xFFFF || next == c + 1, "unexpected chain link {next}");
                c = next;
            }
            out.truncate(size);
            out
        };

        let mut label = String::new();
        let mut entries = Vec::new();
        let mut pending: Vec<(u8, Vec<u16>)> = Vec::new();
        for i in 0..root_entries {
            let off = root_start + i * 32;
            let e = &img[off..off + 32];
            if e[0] == 0x00 {
                break; // end-of-directory marker
            }
            match e[11] {
                0x08 => {
                    label = String::from_utf8_lossy(&e[..11]).trim_end().to_string();
                }
                0x0F => {
                    assert_eq!(e[12], 0, "LFN type byte must be zero");
                    assert_eq!(read_u16(e, 26), 0, "LFN first-cluster field must be 0");
                    let mut units = Vec::new();
                    for k in 0..13 {
                        units.push(read_u16(e, lfn_slot_pos(k)));
                    }
                    pending.push((e[0] & 0x1F, units));
                }
                _ => {
                    pending.sort_by_key(|(ord, _)| *ord);
                    let mut units: Vec<u16> = Vec::new();
                    'outer: for (_, part) in pending.drain(..) {
                        for u in part {
                            if u == 0x0000 {
                                break 'outer;
                            }
                            units.push(u);
                        }
                    }
                    let mut short = [0u8; 11];
                    short.copy_from_slice(&e[..11]);
                    let first_cluster = read_u16(e, 0x1A);
                    let size = read_u32(e, 0x1C);
                    let data = if first_cluster >= 2 {
                        read_chain(first_cluster as u32, size as usize)
                    } else {
                        Vec::new()
                    };
                    entries.push(ParsedFile {
                        lfn: (!units.is_empty())
                            .then(|| String::from_utf16(&units).expect("valid UTF-16")),
                        short,
                        nt_flags: e[12],
                        first_cluster,
                        size,
                        data,
                    });
                }
            }
        }
        Parsed { label, entries }
    }

    // --- ① size + boot signature ---

    #[test]
    fn image_is_64_mib_with_a_valid_boot_signature() {
        let img = build_fat16_image(&three_files()).unwrap();
        assert_eq!(img.len(), SEED_IMAGE_BYTES);
        assert_eq!(SEED_IMAGE_BYTES, 64 * 1024 * 1024);
        assert_eq!(&img[0x1FE..0x200], &[0x55, 0xAA]);
        assert_eq!(&img[0..3], &[0xEB, 0x3C, 0x90]);
    }

    // --- ② BPB fields (layout + the converged FAT size) ---

    #[test]
    fn bpb_fields_describe_the_computed_layout() {
        let img = build_fat16_image(&three_files()).unwrap();
        assert_eq!(&img[3..11], b"MSDOS5.0");
        assert_eq!(read_u16(&img, 0x0B), 512, "bytes per sector");
        assert_eq!(img[0x0D], 4, "sectors per cluster → 2 KiB clusters");
        assert_eq!(read_u16(&img, 0x0E), 4, "reserved sectors (mkfs.fat-parity)");
        assert_eq!(img[0x10], 2, "number of FATs");
        assert_eq!(read_u16(&img, 0x11), 512, "root entries");
        // 131072 sectors cannot fit the 16-bit field; the 32-bit one carries it.
        assert_eq!(read_u16(&img, 0x13), 0, "total_sectors_16");
        assert_eq!(read_u32(&img, 0x20), 131072, "total_sectors_32");
        assert_eq!(img[0x15], 0xF8, "media descriptor");
        assert_eq!(read_u16(&img, 0x16), 128, "sectors per FAT (converged fixed point)");
        assert_eq!(FAT_SECTORS, 128);
        assert_eq!(CLUSTER_COUNT, 32695);
        assert_eq!(read_u16(&img, 0x18), 32, "sectors per track (mkfs.fat parity)");
        assert_eq!(read_u16(&img, 0x1A), 8, "heads (mkfs.fat parity)");
        assert_eq!(img[0x24], 0x80, "drive number");
        assert_eq!(img[0x26], 0x29, "extended boot signature");
        // The string ds-identify's blkid scan matches on.
        assert_eq!(&img[0x2B..0x36], b"CIDATA     ");
        assert_eq!(
            String::from_utf8_lossy(&img[0x2B..0x36]).trim_end(),
            "CIDATA"
        );
        assert_eq!(&img[0x36..0x3E], b"FAT16   ");
        // The FAT header entries: media + end-of-chain marker.
        assert_eq!(read_u16(&img, FAT_START), 0xFFF8);
        assert_eq!(read_u16(&img, FAT_START + 2), 0xFFFF);
    }

    // --- ③ full round trip through the reader ---

    #[test]
    fn root_directory_and_fat_chain_roundtrip_byte_for_byte() {
        let files = three_files();
        let img = build_fat16_image(&files).unwrap();
        let parsed = parse(&img);

        assert_eq!(parsed.label, "CIDATA");
        assert_eq!(parsed.entries.len(), 3);
        // The 8.3 names the standard algorithm derives (`-` is legal in 8.3,
        // so the truncated base keeps it — this is what mtools and the Linux
        // vfat driver both produce).
        let shorts: Vec<String> = parsed
            .entries
            .iter()
            .map(|e| short_name_str(&e.short))
            .collect();
        assert_eq!(shorts, ["USER-D~1", "META-D~1", "NETWOR~1"]);

        for (name, bytes) in &files {
            let e = parsed
                .entries
                .iter()
                .find(|e| e.lfn.as_deref() == Some(name.as_str()))
                .unwrap_or_else(|| panic!("no LFN entry for {name:?}"));
            assert_eq!(e.size as usize, bytes.len());
            assert_eq!(&e.data, bytes, "content mismatch for {name:?}");
            assert_ne!(e.nt_flags & 0x08, 0, "lowercase base must set the NT flag");
            // No extension for these names → first cluster high word unused.
            assert!(e.first_cluster >= 2);
            assert_eq!(read_u16(&img, FAT_START + e.first_cluster as usize * 2), 0xFFFF);
        }
    }

    // --- ④ LFN checksum ---

    #[test]
    fn lfn_checksums_match_an_independent_implementation() {
        // Deliberately re-derived from the published algorithm (shift/rotate
        // with carry folded back in) rather than calling the builder's helper.
        fn reference(name: &[u8; 11]) -> u8 {
            let mut sum: u16 = 0;
            for &b in name {
                sum = ((sum >> 1) | ((sum & 1) << 7)) + b as u16;
                sum &= 0xFF;
            }
            sum as u8
        }

        let img = build_fat16_image(&three_files()).unwrap();
        let bps = read_u16(&img, 0x0B) as usize;
        let root_start = (read_u16(&img, 0x0E) as usize
            + img[0x10] as usize * read_u16(&img, 0x16) as usize)
            * bps;

        let mut seen = 0;
        for i in 0..read_u16(&img, 0x11) as usize {
            let off = root_start + i * 32;
            let e = &img[off..off + 32];
            if e[0] == 0x00 {
                break;
            }
            if e[11] != 0x0F {
                continue;
            }
            // Only the last LFN entry of a chain is followed by the short
            // entry — every entry of one chain carries the same checksum, so
            // verifying it at the chain end covers all of them.
            let next = &img[off + 32..off + 64];
            if next[0] == 0x00 || next[11] == 0x0F {
                continue;
            }
            let mut short = [0u8; 11];
            short.copy_from_slice(&next[..11]);
            assert_eq!(
                e[13],
                reference(&short),
                "LFN checksum must equal the checksum of its 8.3 entry"
            );
            assert_eq!(e[13], lfn_checksum(&short));
            seen += 1;
        }
        assert_eq!(seen, 3, "one LFN chain per short name");
    }

    // --- ⑤ empty file list ---

    #[test]
    fn empty_file_list_leaves_only_the_volume_label() {
        let img = build_fat16_image(&[]).unwrap();
        let parsed = parse(&img);
        assert_eq!(parsed.label, "CIDATA");
        assert!(parsed.entries.is_empty());
        // Slot 1 is the end-of-directory marker: nothing after the label.
        assert_eq!(img[ROOT_DIR_START + 32], 0x00);
        // And the FAT holds nothing but the two reserved entries.
        assert_eq!(read_u16(&img, FAT_START + 2 * 2), 0x0000);
        assert_eq!(read_u16(&img, FAT_START + 3 * 2), 0x0000);
        assert!(img[DATA_START..DATA_START + CLUSTER_BYTES].iter().all(|&b| b == 0));
    }

    // --- ⑥ multi-cluster file (300 KiB → 150 clusters) ---

    #[test]
    fn large_file_spans_a_contiguous_multi_cluster_chain() {
        let payload: Vec<u8> = (0..300 * 1024).map(|i| (i * 31 + 7) as u8).collect();
        let files = vec![
            ("meta-data".to_string(), b"instance-id: iid-x\n".to_vec()),
            ("big-disk-image".to_string(), payload.clone()),
            ("network-config".to_string(), b"version: 2\n".to_vec()),
        ];
        let img = build_fat16_image(&files).unwrap();
        let parsed = parse(&img);
        let big = parsed
            .entries
            .iter()
            .find(|e| e.lfn.as_deref() == Some("big-disk-image"))
            .expect("big file entry");

        let clusters = payload.len().div_ceil(CLUSTER_BYTES);
        assert_eq!(clusters, 150);
        assert_eq!(big.size as usize, payload.len());
        assert_eq!(big.data, payload, "300 KiB must survive the cluster chain");
        // Chains are allocated in file order: the big file follows meta-data.
        assert_eq!(big.first_cluster, 3);

        let mut chain = vec![big.first_cluster as u32];
        let mut c = big.first_cluster as u32;
        loop {
            let next = read_u16(&img, FAT_START + c as usize * 2) as u32;
            if next == 0xFFFF {
                break;
            }
            assert_eq!(next, c + 1, "chain must be contiguous in file order");
            chain.push(next);
            c = next;
            assert!(chain.len() < 1000, "chain did not terminate");
        }
        assert_eq!(chain.len(), clusters);
        assert_eq!(chain[0], 3);
        assert_eq!(*chain.last().unwrap(), 2 + 150);
        // The third file starts right after it (clusters 3..=152 for the big
        // file → the next allocation is 153).
        let network = parsed
            .entries
            .iter()
            .find(|e| e.lfn.as_deref() == Some("network-config"))
            .unwrap();
        assert_eq!(network.first_cluster as u32, 3 + 150);
    }

    // --- ⑦ determinism + the two FAT copies ---

    #[test]
    fn build_is_deterministic_and_fat2_mirrors_fat1() {
        let files = three_files();
        let a = build_fat16_image(&files).unwrap();
        let b = build_fat16_image(&files).unwrap();
        assert_eq!(a, b, "pure builder must be byte-identical across runs");
        assert_eq!(
            a[FAT_START..FAT_START + FAT_BYTES],
            a[FAT_START + FAT_BYTES..FAT_START + 2 * FAT_BYTES],
            "FAT #2 must be an exact copy of FAT #1"
        );
        // A different file list must produce a different image.
        let mut other = three_files();
        other.push(("extra".to_string(), b"x".to_vec()));
        assert_ne!(a, build_fat16_image(&other).unwrap());
    }

    // --- ⑧ 8.3 derivation: truncation, lossy mangling, collisions ---

    #[test]
    fn short_names_truncate_mangle_and_resolve_collisions() {
        let mut used = BTreeSet::new();
        let case = |long: &str, used: &mut BTreeSet<[u8; 11]>| {
            short_name_str(&derive_short_name(long, used).unwrap().bytes)
        };
        // Fits 8.3: only the case changes (recorded in the NT byte).
        assert_eq!(case("abc.txt", &mut used), "ABC.TXT");
        // A 4-char extension does not fit 8.3 → lossy → tail + truncated ext.
        assert_eq!(case("meta.data", &mut used), "META~1.DAT");
        // Too long without an extension → 6 chars + ~1.
        assert_eq!(case("user-data", &mut used), "USER-D~1");
        // Spaces are removed (a lossy change → ~1 even though it would fit).
        assert_eq!(case("a b.txt", &mut used), "AB~1.TXT");
        // Two long names that mangle to the same 8.3 base: the tail bumps.
        assert_eq!(case("user-data2", &mut used), "USER-D~2");
        // Non-ASCII has no OEM mapping here → `_` (and lossy → ~1).
        assert_eq!(case("配置文件", &mut used), "____~1");
        // Dots collapse to `_`; the name is still usable.
        assert_eq!(case("...", &mut used), "___~1");
        // Nothing usable → a clear error, never a silent bad name.
        assert!(derive_short_name("", &mut BTreeSet::new()).is_err());
    }

    // --- ⑨ the real seed renderers survive the FAT carrier ---

    #[test]
    fn cloudinit_seed_files_roundtrip_through_the_fat16_builder() {
        let cfg = crate::cloudinit::CloudInitConfig {
            hostname: "qc-node-1".to_string(),
            ssh_pubkey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey qc-test".to_string(),
            docker_install: "get-docker".to_string(),
        };
        let files = crate::cloudinit::seed_image_files(&cfg).unwrap();
        let img = build_fat16_image(&files).unwrap();
        let parsed = parse(&img);

        assert_eq!(parsed.label, "CIDATA");
        assert_eq!(parsed.entries.len(), 3);
        let names: Vec<&str> = parsed
            .entries
            .iter()
            .map(|e| e.lfn.as_deref().expect("every seed file needs an LFN name"))
            .collect();
        assert_eq!(names, ["user-data", "meta-data", "network-config"]);
        for (name, bytes) in &files {
            let e = parsed
                .entries
                .iter()
                .find(|e| e.lfn.as_deref() == Some(name.as_str()))
                .unwrap();
            assert_eq!(&e.data, bytes, "rendered {name} must survive verbatim");
            assert!(!e.data.is_empty());
        }
    }

    // --- ⑩ guards ---

    #[test]
    fn builder_rejects_names_beyond_the_lfn_limit_and_over_capacity() {        let too_long = "x".repeat(256);
        let err = build_fat16_image(&[(too_long, vec![1, 2, 3])]).unwrap_err();
        assert!(err.contains("255"), "unexpected error: {err}");
        // 512 single-LFN files × (1 LFN + 1 short) exceed the 512 root slots
        // (one of which is taken by the volume label).
        let files: Vec<(String, Vec<u8>)> = (0..512)
            .map(|i| (format!("f{i:04}"), vec![0u8; 1]))
            .collect();
        let err = build_fat16_image(&files).unwrap_err();
        assert!(err.contains("root directory full"), "unexpected error: {err}");
    }
}
