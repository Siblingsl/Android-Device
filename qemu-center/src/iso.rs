//! Minimal ISO9660 (ECMA-119) image builder for cloud-init NoCloud seed discs.
//!
//! **Retired as a seed carrier, kept as a library API + test asset.** The
//! `map=normal` assumption below was falsified on the user's real WHPX host:
//! the guest's cloud-init never saw the lowercase names and ignored the seed
//! entirely (public-key auth refused). The current carrier is
//! [`crate::fat::build_fat16_image`] — see that module and the README.
//!
//! Zero-dependency by design (project red line): only `std`. The generator
//! produces a **single-level directory** ISO (no subdirectories, no Joliet,
//! no Rock Ridge) holding the small NoCloud seed files — user-data, meta-data,
//! network-config — which is all cloud-init needs.
//!
//! Compliance notes / deliberate simplifications:
//! * 2048-byte sectors; system area = 16 sectors of zeros; PVD at LBA 16;
//!   Volume Descriptor Set Terminator at LBA 17.
//! * One Type-L (LE) and one Type-M (BE) path table, root entry only, each
//!   padded to one sector.
//! * File identifiers are written ISO9660-style as `NAME.;1` (uppercase,
//!   version 1). The build once bet on Linux mounting iso9660 with
//!   `map=normal` by default, which lowercases identifiers and strips the
//!   trailing `.;1`, so `USER-DATA.;1` would appear as `user-data` — that bet
//!   did not pay off on the real guest (see the retirement note above). Names
//!   must still contain no `.` / `;` (enforced by `validate_name`).
//! * Volume identifier is `CIDATA` (cloud-init NoCloud accepts `cidata` /
//!   `CIDATA`; the kernel surfaces the PVD string as-is).
//! * All timestamps are a fixed epoch (2026-01-01 00:00:00 +0000) so that the
//!   same input always yields byte-identical output (build determinism).
//! * `parse_iso` re-reads a built image back into files; it backs the
//!   round-trip tests and can be reused by tooling to audit a written seed.

const SECTOR: usize = 2048;
const PVD_LBA: u32 = 16;
const TERMINATOR_LBA: u32 = 17;
const PATH_TABLE_L_LBA: u32 = 18;
const PATH_TABLE_M_LBA: u32 = 19;
const ROOT_DIR_LBA: u32 = 20;

/// Volume label required by cloud-init's NoCloud datasource.
pub const CIDATA_VOLUME_ID: &str = "CIDATA";

/// Fixed recording date for determinism: 2026-01-01 00:00:00 +0000.
const FIXED_DATE_7: [u8; 7] = [126, 1, 1, 0, 0, 0, 0]; // years since 1900 = 126

const SYSTEM_ID: &str = "QEMUCENTER";
/// Sanity cap: NoCloud seeds are a few KiB; refuse accidental misuse.
const MAX_TOTAL_FILE_BYTES: usize = 16 * 1024 * 1024;
const MAX_FILES: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IsoError {
    /// Name empty, too long, or contains ISO-unsafe chars (`.` or `;`).
    BadName(String),
    TooManyFiles(usize),
    FileTooLarge(usize),
    /// Parsed bytes do not look like an ISO9660 image.
    NotIso(&'static str),
    /// Parsed image is truncated / internally inconsistent.
    Truncated(&'static str),
}

impl std::fmt::Display for IsoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IsoError::BadName(n) => write!(
                f,
                "invalid ISO file name {n:?}: use 1..=24 chars of [A-Za-z0-9_-], no '.' or ';'"
            ),
            IsoError::TooManyFiles(n) => write!(f, "too many files ({n} > {MAX_FILES})"),
            IsoError::FileTooLarge(n) => write!(f, "file too large ({n} bytes)"),
            IsoError::NotIso(m) => write!(f, "not an ISO9660 image: {m}"),
            IsoError::Truncated(m) => write!(f, "ISO image truncated: {m}"),
        }
    }
}

impl std::error::Error for IsoError {}

fn sectors_for(bytes: usize) -> u32 {
    ((bytes + SECTOR - 1) / SECTOR) as u32
}

/// Uppercase the logical name and enforce the character set this generator
/// supports (letters, digits, `_`, `-`; no `.` or `;` — see module docs).
fn validate_name(name: &str) -> Result<String, IsoError> {
    let up = name.to_ascii_uppercase();
    if up.is_empty() || up.len() > 24 {
        return Err(IsoError::BadName(name.to_string()));
    }
    if !up.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(IsoError::BadName(name.to_string()));
    }
    Ok(up)
}

fn put_u16_le(buf: &mut [u8], at: usize, v: u16) {
    buf[at..at + 2].copy_from_slice(&v.to_le_bytes());
}
fn put_u16_be(buf: &mut [u8], at: usize, v: u16) {
    buf[at..at + 2].copy_from_slice(&v.to_be_bytes());
}
fn put_u32_le(buf: &mut [u8], at: usize, v: u32) {
    buf[at..at + 4].copy_from_slice(&v.to_le_bytes());
}
fn put_u32_be(buf: &mut [u8], at: usize, v: u32) {
    buf[at..at + 4].copy_from_slice(&v.to_be_bytes());
}
fn get_u32_le(buf: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(buf[at..at + 4].try_into().expect("u32 LE slice"))
}

fn pad_str(buf: &mut [u8], at: usize, len: usize, s: &str) {
    let bytes = s.as_bytes();
    let n = bytes.len().min(len);
    buf[at..at + n].copy_from_slice(&bytes[..n]);
    for b in &mut buf[at + n..at + len] {
        *b = b' ';
    }
}

/// One ISO9660 directory record (ECMA-119 §9.1).
/// `ident` is the raw identifier bytes (root `.` = [0], `..` = [1]).
#[allow(clippy::too_many_arguments)]
fn write_dir_record(
    buf: &mut Vec<u8>,
    sector_start: usize,
    extent: u32,
    data_len: u32,
    flags: u8,
    ident: &[u8],
) {
    let mut rec = vec![0u8; 32 + ident.len() + (ident.len() & 1)];
    let rl = rec.len();
    rec[0] = rl as u8;
    put_u32_le(&mut rec, 1, extent);
    put_u32_be(&mut rec, 5, extent);
    put_u32_le(&mut rec, 9, data_len);
    put_u32_be(&mut rec, 13, data_len);
    rec[17..24].copy_from_slice(&FIXED_DATE_7);
    rec[24] = flags; // bit0: directory, bit1: associated, ...
    rec[25] = 0; // file unit size
    rec[26] = 0; // interleave gap
    put_u16_le(&mut rec, 27, 1); // volume sequence number
    put_u16_be(&mut rec, 29, 1);
    rec[31] = ident.len() as u8;
    rec[32..32 + ident.len()].copy_from_slice(ident);

    // Records must not straddle a sector boundary: pad to the next sector
    // instead of splitting (ECMA-119 §6.8.1.1).
    if buf.len() - sector_start + rl > SECTOR {
        while buf.len() % SECTOR != 0 {
            buf.push(0);
        }
    }
    buf.extend_from_slice(&rec);
}

/// Build a single-level ISO9660 image holding `files` (logical names will be
/// uppercased and get the standard `.;1` version suffix in the image).
pub fn build_iso(files: &[(&str, &[u8])]) -> Result<Vec<u8>, IsoError> {
    if files.len() > MAX_FILES {
        return Err(IsoError::TooManyFiles(files.len()));
    }

    // Canonical order: sort by normalized name so equal inputs (in any
    // order) produce identical images.
    let mut norm: Vec<(String, Vec<u8>)> = files
        .iter()
        .map(|(n, c)| validate_name(n).map(|u| (u, c.to_vec())))
        .collect::<Result<_, _>>()?;
    norm.sort_by(|a, b| a.0.cmp(&b.0));
    for (i, (n, _)) in norm.iter().enumerate() {
        if i + 1 < norm.len() && norm[i + 1].0 == *n {
            return Err(IsoError::BadName(format!("{n} (duplicate)")));
        }
    }
    for (_, c) in norm.iter() {
        if c.len() > MAX_TOTAL_FILE_BYTES {
            return Err(IsoError::FileTooLarge(c.len()));
        }
    }
    if norm.iter().map(|(_, c)| c.len()).sum::<usize>() > MAX_TOTAL_FILE_BYTES {
        return Err(IsoError::FileTooLarge(
            norm.iter().map(|(_, c)| c.len()).sum(),
        ));
    }

    // ---- Pass 1: root directory extent size (record lengths are extent-independent).
    let mut probe: Vec<u8> = Vec::new();
    write_dir_record(&mut probe, 0, 0, 0, 2, &[0]); // "."
    write_dir_record(&mut probe, 0, 0, 0, 2, &[1]); // ".."
    for (n, _) in &norm {
        let ident = format!("{n}.;1").into_bytes();
        write_dir_record(&mut probe, 0, 0, 0, 0, &ident);
    }
    let root_sectors = sectors_for(probe.len());

    // ---- Assign file extents.
    let mut file_lba = ROOT_DIR_LBA + root_sectors;
    let mut extents: Vec<(String, u32, usize)> = Vec::new();
    for (n, c) in &norm {
        extents.push((n.clone(), file_lba, c.len()));
        file_lba += sectors_for(c.len());
    }
    let total_sectors = file_lba.max(ROOT_DIR_LBA + root_sectors + 1);
    let volume_space = total_sectors;

    // ---- Path table (single root entry) — identical bytes, LBA endianness differs.
    let mut pt_l = vec![0u8; SECTOR];
    pt_l[0] = 1; // len_di (root: 1 byte, identifier 0x00)
    pt_l[1] = 0; // extended attribute record length
    put_u32_le(&mut pt_l, 2, ROOT_DIR_LBA);
    put_u16_le(&mut pt_l, 6, 1); // parent directory number
    pt_l[8] = 0; // identifier "\0"
    // record length 9 -> pad to even (byte 9 stays 0)
    let path_table_size = 10u32;
    let mut pt_m = pt_l.clone();
    put_u32_be(&mut pt_m, 2, ROOT_DIR_LBA);
    put_u16_be(&mut pt_m, 6, 1);

    // ---- Root directory extent.
    let mut root: Vec<u8> = Vec::new();
    let root_start = 0usize;
    write_dir_record(&mut root, root_start, ROOT_DIR_LBA, root_sectors * SECTOR as u32, 2, &[0]);
    write_dir_record(&mut root, root_start, ROOT_DIR_LBA, root_sectors * SECTOR as u32, 2, &[1]);
    for (n, lba, len) in &extents {
        let ident = format!("{n}.;1").into_bytes();
        write_dir_record(&mut root, root_start, *lba, *len as u32, 0, &ident);
    }
    debug_assert_eq!(root.len(), probe.len());

    // ---- Assemble.
    let mut img = vec![0u8; total_sectors as usize * SECTOR];

    // PVD at LBA 16 (offsets follow the Linux `struct iso_primary_descriptor`).
    let pvd_at = PVD_LBA as usize * SECTOR;
    img[pvd_at] = 1; // Volume Descriptor Type = Primary
    img[pvd_at + 1..pvd_at + 6].copy_from_slice(b"CD001");
    img[pvd_at + 6] = 1; // version
    pad_str(&mut img, pvd_at + 8, 32, SYSTEM_ID);
    pad_str(&mut img, pvd_at + 40, 32, CIDATA_VOLUME_ID);
    put_u32_le(&mut img, pvd_at + 72, volume_space);
    put_u32_be(&mut img, pvd_at + 76, volume_space);
    put_u16_le(&mut img, pvd_at + 80, 1); // volume set size
    put_u16_be(&mut img, pvd_at + 82, 1);
    put_u16_le(&mut img, pvd_at + 84, 1); // volume sequence number
    put_u16_be(&mut img, pvd_at + 86, 1);
    put_u16_le(&mut img, pvd_at + 88, SECTOR as u16); // logical block size
    put_u16_be(&mut img, pvd_at + 90, SECTOR as u16);
    put_u32_le(&mut img, pvd_at + 92, path_table_size);
    put_u32_be(&mut img, pvd_at + 96, path_table_size);
    put_u32_le(&mut img, pvd_at + 100, PATH_TABLE_L_LBA);
    put_u32_le(&mut img, pvd_at + 104, 0); // optional type L absent
    put_u32_be(&mut img, pvd_at + 108, PATH_TABLE_M_LBA);
    put_u32_be(&mut img, pvd_at + 112, 0); // optional type M absent
    img[pvd_at + 116..pvd_at + 116 + 34]
        .copy_from_slice(&root[..34]); // root directory record (74-byte field, 34 used)
    pad_str(&mut img, pvd_at + 190, 32, CIDATA_VOLUME_ID); // volume set id
    pad_str(&mut img, pvd_at + 318, 128, "qemu-center"); // publisher
    pad_str(&mut img, pvd_at + 446, 128, "qemu-center iso.rs"); // data preparer
    pad_str(&mut img, pvd_at + 574, 128, "QEMU-CENTER"); // application
    // Volume dates: 17-byte "YYYYMMDDHHmmssHHo" ASCII, fixed for determinism.
    let dt = b"2026010100000000\x00"; // 2026-01-01 00:00:00.00 +00:00
    for off in [813usize, 830, 847, 864] {
        img[pvd_at + off..pvd_at + off + 17].copy_from_slice(dt);
    }
    img[pvd_at + 881] = 1; // file structure version

    // Terminator at LBA 17.
    let t_at = TERMINATOR_LBA as usize * SECTOR;
    img[t_at] = 255;
    img[t_at + 1..t_at + 6].copy_from_slice(b"CD001");
    img[t_at + 6] = 1;

    // Path tables.
    img[PATH_TABLE_L_LBA as usize * SECTOR..(PATH_TABLE_L_LBA as usize + 1) * SECTOR]
        .copy_from_slice(&pt_l);
    img[PATH_TABLE_M_LBA as usize * SECTOR..(PATH_TABLE_M_LBA as usize + 1) * SECTOR]
        .copy_from_slice(&pt_m);

    // Root directory extent.
    let root_off = ROOT_DIR_LBA as usize * SECTOR;
    img[root_off..root_off + root.len()].copy_from_slice(&root);

    // File data (each padded to a full sector).
    for ((_, contents), (_, lba, _)) in norm.iter().zip(extents.iter()) {
        let off = *lba as usize * SECTOR;
        img[off..off + contents.len()].copy_from_slice(contents);
    }

    Ok(img)
}

/// A file read back from a parsed image (identifier normalized to the logical
/// name: `USER-DATA.;1` -> `user-data`).
pub struct ParsedIso {
    pub volume_id: String,
    pub files: Vec<(String, Vec<u8>)>,
}

/// Parse back a (single-level, no Rock Ridge) ISO9660 image built by
/// `build_iso`. Also tolerant of images with a Joliet SVD (ignored).
pub fn parse_iso(bytes: &[u8]) -> Result<ParsedIso, IsoError> {
    if bytes.len() < 3 * SECTOR {
        return Err(IsoError::Truncated("shorter than 3 sectors"));
    }
    let pvd_at = PVD_LBA as usize * SECTOR;
    if bytes[pvd_at] != 1 {
        return Err(IsoError::NotIso("LBA 16 is not a Primary Volume Descriptor"));
    }
    if &bytes[pvd_at + 1..pvd_at + 6] != b"CD001" {
        return Err(IsoError::NotIso("missing CD001 standard identifier"));
    }
    if bytes[pvd_at + 881] != 1 {
        return Err(IsoError::NotIso("unexpected file structure version"));
    }
    let volume_id = String::from_utf8_lossy(&bytes[pvd_at + 40..pvd_at + 72])
        .trim_end_matches(' ')
        .to_string();

    // Terminator present right after the PVD (our builder always puts it at 17).
    let t_at = TERMINATOR_LBA as usize * SECTOR;
    if bytes.len() > t_at && bytes[t_at] == 255 && &bytes[t_at + 1..t_at + 6] != b"CD001" {
        return Err(IsoError::NotIso("terminator lacks CD001 id"));
    }

    // Root directory record (74-byte field at PVD offset 116).
    let root_rec = &bytes[pvd_at + 116..pvd_at + 190];
    let root_len = root_rec[0] as usize;
    if root_len == 0 || root_len > 74 || pvd_at + 116 + root_len > bytes.len() {
        return Err(IsoError::Truncated("bad root directory record"));
    }
    let root_extent = get_u32_le(root_rec, 1) as usize;
    let root_size = get_u32_le(root_rec, 9) as usize;
    let root_off = root_extent
        .checked_mul(SECTOR)
        .ok_or(IsoError::Truncated("root extent overflow"))?;
    if root_off + root_size > bytes.len() {
        return Err(IsoError::Truncated("root extent out of bounds"));
    }

    let mut files = Vec::new();
    let mut o = root_off;
    let end = root_off + root_size;
    while o < end {
        let rl = bytes[o] as usize;
        if rl == 0 {
            // Rest of sector is padding; skip to next sector.
            o = (o / SECTOR + 1) * SECTOR;
            continue;
        }
        if o + rl > end {
            return Err(IsoError::Truncated("directory record overruns extent"));
        }
        let rec = &bytes[o..o + rl];
        o += rl;
        let flags = rec[24];
        if flags & 0b1 != 0 {
            continue; // subdirectory (only "." / ".." in our images)
        }
        let ident_len = rec[31] as usize;
        let ident = &rec[32..32 + ident_len];
        if ident == [0] || ident == [1] {
            continue; // "." and ".."
        }
        // Normalize: strip ";1" version, strip a trailing '.', lowercase.
        let mut name = String::from_utf8_lossy(ident).to_string();
        if let Some(p) = name.rfind(';') {
            name.truncate(p);
        }
        while name.ends_with('.') {
            name.pop();
        }
        let name = name.to_ascii_lowercase();

        let extent = get_u32_le(rec, 1) as usize;
        let dlen = get_u32_le(rec, 9) as usize;
        let data_off = extent
            .checked_mul(SECTOR)
            .ok_or(IsoError::Truncated("file extent overflow"))?;
        if data_off + dlen > bytes.len() {
            return Err(IsoError::Truncated("file data out of bounds"));
        }
        files.push((name, bytes[data_off..data_off + dlen].to_vec()));
    }

    Ok(ParsedIso { volume_id, files })
}

/// Total on-disk size in bytes of the image `build_iso` would emit for these
/// inputs (same arithmetic as the builder; exposed for tests and sizing logs).
pub fn iso_size_bytes(files: &[(&str, &[u8])]) -> usize {
    // Root extent: ".", ".." (ident length 1 -> 34-byte records) + one record
    // per file (ident = NAME + ".;1" = len+3, padded to even record length).
    let mut root_bytes = 2 * 34;
    for (name, _) in files {
        let ident = name.len() + 3;
        root_bytes += 32 + ident + (ident & 1);
    }
    let root_sectors = sectors_for(root_bytes) as usize;
    let mut sectors = (ROOT_DIR_LBA as usize) + root_sectors;
    for (_, c) in files {
        sectors += sectors_for(c.len()) as usize;
    }
    sectors * SECTOR
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<(&'static str, Vec<u8>)> {
        vec![
            ("user-data", b"#cloud-config\nhostname: vm0\n".to_vec()),
            ("meta-data", b"instance-id: iid-vm0\n".to_vec()),
            (
                "network-config",
                b"version: 2\nethernets:\n  all:\n    dhcp4: true\n".to_vec(),
            ),
        ]
    }

    fn sample_refs<'a>(v: &'a [(&'static str, Vec<u8>)]) -> Vec<(&'a str, &'a [u8])> {
        v.iter().map(|(n, c)| (*n, c.as_slice())).collect()
    }

    #[test]
    fn cd001_marker_at_0x8001() {
        let img = build_iso(&sample_refs(&sample())).unwrap();
        assert_eq!(&img[0x8001..0x8006], b"CD001");
        assert_eq!(img[0x8000], 1); // PVD type
        assert_eq!(img[0x8000 + 881], 1); // file structure version
    }

    #[test]
    fn volume_id_is_cidata() {
        let img = build_iso(&sample_refs(&sample())).unwrap();
        let vid = &img[0x8000 + 40..0x8000 + 72];
        assert_eq!(String::from_utf8_lossy(vid).trim_end_matches(' '), "CIDATA");
    }

    #[test]
    fn terminator_at_lba_17() {
        let img = build_iso(&sample_refs(&sample())).unwrap();
        let t = 17 * 2048;
        assert_eq!(img[t], 255);
        assert_eq!(&img[t + 1..t + 6], b"CD001");
    }

    #[test]
    fn image_size_is_whole_sectors_and_matches_space_size() {
        let img = build_iso(&sample_refs(&sample())).unwrap();
        assert_eq!(img.len() % 2048, 0);
        // Volume space size (LE at PVD+72) must equal the image sector count.
        let sectors = get_u32_le(&img, 0x8000 + 72) as usize;
        assert_eq!(sectors * 2048, img.len());
        // Formula agrees.
        assert_eq!(iso_size_bytes(&sample_refs(&sample())), img.len());
    }

    #[test]
    fn parse_roundtrip_recovers_all_files() {
        let sample = sample();
        let img = build_iso(&sample_refs(&sample)).unwrap();
        let parsed = parse_iso(&img).unwrap();
        assert_eq!(parsed.volume_id, "CIDATA");
        assert_eq!(parsed.files.len(), 3);
        let mut got: Vec<(String, String)> = parsed
            .files
            .iter()
            .map(|(n, c)| (n.clone(), String::from_utf8_lossy(c).to_string()))
            .collect();
        got.sort();
        assert_eq!(got[0].0, "meta-data");
        assert_eq!(got[0].1, "instance-id: iid-vm0\n");
        assert_eq!(got[1].0, "network-config");
        assert!(got[1].1.contains("dhcp4: true"));
        assert_eq!(got[2].0, "user-data");
        assert_eq!(got[2].1, "#cloud-config\nhostname: vm0\n");
    }

    #[test]
    fn parse_skips_dot_and_dotdot_records() {
        let img = build_iso(&sample_refs(&sample())).unwrap();
        let parsed = parse_iso(&img).unwrap();
        // No directory entries leak into the file list.
        assert!(parsed.files.iter().all(|(n, _)| n != "." && n != ".."));
    }

    #[test]
    fn determinism_same_input_same_output() {
        let a = build_iso(&sample_refs(&sample())).unwrap();
        let b = build_iso(&sample_refs(&sample())).unwrap();
        assert_eq!(a, b);
        // Input order does not matter (canonical sort inside).
        let mut shuffled = sample();
        shuffled.reverse();
        let c = build_iso(&sample_refs(&shuffled)).unwrap();
        assert_eq!(a, c);
        // Different input -> different output (sanity, not required by spec).
        let mut other = sample();
        other[0].1.push(b'x');
        assert_ne!(a, build_iso(&sample_refs(&other)).unwrap());
    }

    #[test]
    fn empty_file_list_still_yields_mountable_image() {
        let img = build_iso(&[]).unwrap();
        assert_eq!(img.len() % 2048, 0);
        let parsed = parse_iso(&img).unwrap();
        assert_eq!(parsed.volume_id, "CIDATA");
        assert!(parsed.files.is_empty());
    }

    #[test]
    fn bad_names_are_rejected() {
        assert!(matches!(
            build_iso(&[("bad;name", b"x")]),
            Err(IsoError::BadName(_))
        ));
        assert!(matches!(
            build_iso(&[("a.b", b"x")]),
            Err(IsoError::BadName(_))
        ));
        assert!(matches!(build_iso(&[("", b"x")]), Err(IsoError::BadName(_))));
        let long = "n".repeat(25);
        assert!(matches!(
            build_iso(&[(long.as_str(), b"x")]),
            Err(IsoError::BadName(_))
        ));
    }

    #[test]
    fn duplicate_names_rejected() {
        assert!(matches!(
            build_iso(&[("user-data", b"x"), ("USER-DATA", b"y")]),
            Err(IsoError::BadName(_))
        ));
    }

    #[test]
    fn path_table_locations_recorded() {
        let img = build_iso(&sample_refs(&sample())).unwrap();
        let p = 0x8000;
        let l = get_u32_le(&img, p + 100);
        let m = u32::from_be_bytes(img[p + 108..p + 112].try_into().unwrap());
        assert_eq!(l, 18);
        assert_eq!(m, 19);
        // Type-L path table root entry points at the root extent.
        let pt = 18 * 2048;
        assert_eq!(get_u32_le(&img, pt + 2), 20);
    }

    #[test]
    fn large_file_pads_to_sector_boundary() {
        // 5000 bytes -> 3 sectors of storage; next file must not overlap.
        let files = vec![
            ("big", vec![7u8; 5000]),
            ("next", b"tail".to_vec()),
        ];
        let refs: Vec<(&str, &[u8])> = files
            .iter()
            .map(|(n, c)| (*n, c.as_slice()))
            .collect();
        let img = build_iso(&refs).unwrap();
        let parsed = parse_iso(&img).unwrap();
        let mut got = parsed.files;
        got.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(got.len(), 2);
        assert_eq!(got[1].0, "next");
        assert_eq!(got[1].1, b"tail");
        assert_eq!(got[0].1.len(), 5000);
        assert!(got[0].1.iter().all(|&b| b == 7));
    }

    #[test]
    fn many_files_records_do_not_straddle_sectors() {
        // 24 files force the root extent past one sector; every directory
        // record must sit entirely inside a single sector.
        let files: Vec<(String, Vec<u8>)> = (0..24)
            .map(|i| (format!("f{i:02}"), b"data".to_vec()))
            .collect();
        let refs: Vec<(&str, &[u8])> =
            files.iter().map(|(n, c)| (n.as_str(), c.as_slice())).collect();
        let img = build_iso(&refs).unwrap();
        // Walk records exactly like parse_iso and assert the no-straddle rule.
        let root = &img[20 * 2048..21 * 2048];
        let mut o = 0usize;
        while o < root.len() && root[o] != 0 {
            let rl = root[o] as usize;
            assert!(o % 2048 + rl <= 2048, "record straddles sector at {o}");
            o += rl;
        }
        let parsed = parse_iso(&img).unwrap();
        assert_eq!(parsed.files.len(), 24);
    }

    #[test]
    fn parse_rejects_garbage() {
        // 20 sectors so LBA 16 (0x8000) and the terminator LBA exist.
        let mut junk = vec![0u8; 20 * 2048];
        junk[0x8000] = 7; // not a PVD
        assert!(matches!(parse_iso(&junk), Err(IsoError::NotIso(_))));
        assert!(matches!(parse_iso(&[0u8; 100]), Err(IsoError::Truncated(_))));
        // A PVD that claims a root extent beyond the image.
        let mut img = build_iso(&sample_refs(&sample())).unwrap();
        let p = 0x8000 + 116;
        img[p + 1..p + 5].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(matches!(parse_iso(&img), Err(IsoError::Truncated(_))));
    }

    #[test]
    fn root_record_in_pvd_matches_root_extent() {
        let img = build_iso(&sample_refs(&sample())).unwrap();
        let p = 0x8000 + 116;
        assert_eq!(img[p], 34); // record length
        assert_eq!(img[p + 24], 2); // directory flag
        let extent = get_u32_le(&img, p + 1);
        assert_eq!(extent, 20); // ROOT_DIR_LBA
        let dlen = get_u32_le(&img, p + 9);
        assert!(dlen >= 5 * 34); // at least ".", ".." + 3 files
        assert_eq!(dlen % 2048, 0); // directory extents are sector-aligned
    }

    #[test]
    fn seed_files_survive_build_parse_with_exact_bytes() {
        // The cloud-init contract: byte-exact file contents under the exact
        // logical names, whatever the on-disc identifier spelling is.
        let contents = b"ssh_pwauth: false\nusers:\n  - name: rdc\n";
        let img = build_iso(&[("user-data", contents)]).unwrap();
        let parsed = parse_iso(&img).unwrap();
        assert_eq!(parsed.files, vec![("user-data".to_string(), contents.to_vec())]);
    }
}
