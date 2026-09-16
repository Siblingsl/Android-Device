// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QemuCenterPage } from "./QemuCenter";
import { useAppStore } from "../stores/appStore";
import type {
  QemuCliOutput,
  QemuDoctorReport,
  QemuRedroidInstance,
  QemuVerifyReport,
  QemuVmEntry,
} from "../types";

vi.mock("../services/deviceService", () => ({
  QemuService: {
    doctor: vi.fn(),
    setup: vi.fn(),
    vmList: vi.fn(),
    vmCreate: vi.fn(),
    vmStart: vi.fn(),
    vmStop: vi.fn(),
    vmDelete: vi.fn(),
    vmSnapshot: vi.fn(),
    vmRestore: vi.fn(),
    guestWait: vi.fn(),
    redroidCreate: vi.fn(),
    redroidUpgrade: vi.fn(),
    redroidRestore: vi.fn(),
    redroidList: vi.fn(),
    adbList: vi.fn(),
    verify: vi.fn(),
  },
  // The real appStore (used below to verify cross-page survival) imports this.
  DeviceService: {
    getSystemStatus: vi.fn(async () => null),
    listDevices: vi.fn(async () => []),
    getSettings: vi.fn(async () => null),
    updateSettings: vi.fn(async (s: unknown) => s),
    getLocalGappsPath: vi.fn(async () => "C:/assets/gapps.zip"),
    getMagiskAssets: vi.fn(async () => ({ magiskOk: true, lsposedOk: true, shamikoOk: true })),
    listSpoofProfiles: vi.fn(async () => [{ id: "captured-phone", model: "My phone" }]),
  },
}));
vi.mock("../lib/dialogs", () => ({ askConfirm: vi.fn(async () => true) }));
vi.mock("../lib/clipboard", () => ({ copyText: vi.fn() }));

const { QemuService } = await import("../services/deviceService");

const cliOk = (stdout = "ok"): QemuCliOutput => ({ success: true, exitCode: 0, stdout, stderr: "" });

/** Deferred helper for simulating the long-running Rust CLI child. */
function deferredSetup(): { resolve: (output: QemuCliOutput) => void } {
  const ref = {} as { resolve: (output: QemuCliOutput) => void };
  vi.mocked(QemuService.setup).mockImplementationOnce(
    () =>
      new Promise<QemuCliOutput>((res) => {
        ref.resolve = res;
      }),
  );
  // The impl runs at click time, so hand back a holder instead of the value.
  return ref;
}

const doctorFixture: QemuDoctorReport = {
  stateDir: "C:/Users/u/AppData/Roaming/QemuCenter",
  checks: [
    {
      id: "whpx",
      title: "WHPX feature",
      status: "fail",
      detail: "HypervisorPlatform = Disabled",
      fix: "qemu-center setup whpx",
    },
    { id: "qemu", title: "QEMU installed", status: "ok", detail: "8.2.0", fix: "" },
    { id: "disk", title: "Free disk", status: "unknown", detail: "unparsable", fix: "" },
  ],
};

const vmsFixture: QemuVmEntry[] = [
  {
    name: "node1",
    vcpus: 4,
    memMib: 4096,
    accel: "whpx",
    sshHostPort: 22300,
    adbPorts: [24500, 24501],
    adbAssignments: [{ instance: "r1", port: 24500, serial: "127.0.0.1:24500" }],
  },
];

const instancesFixture: QemuRedroidInstance[] = [
  {
    instance: "r1",
    container: "qc-r1",
    port: 24500,
    serial: "127.0.0.1:24500",
    status: "Up 2 minutes",
  },
];

const verifyFixture: QemuVerifyReport = {
  vm: "node1",
  container: "qc-r1",
  checks: [
    { id: "whpx", title: "WHPX usable", verdict: "PASS", detail: "probe exit 0" },
    { id: "ssh", title: "guest SSH reachable", verdict: "FAIL", detail: "connection refused" },
    { id: "binderfs", title: "binderfs mounted", verdict: "UNTESTED", detail: "vm stopped" },
  ],
};

function renderPage() {
  return render(
    <MemoryRouter>
      <QemuCenterPage />
    </MemoryRouter>,
  );
}

/** Flush the mount-time loads (doctor + vm list). */
async function flushLoads() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("QemuCenterPage", () => {
  beforeEach(() => {
    useAppStore.setState({ qemuSetup: null, qemuWaitVm: null });
    vi.mocked(QemuService.doctor).mockResolvedValue(doctorFixture);
    vi.mocked(QemuService.vmList).mockResolvedValue(vmsFixture);
    vi.mocked(QemuService.redroidList).mockResolvedValue(instancesFixture);
    vi.mocked(QemuService.setup).mockResolvedValue(cliOk());
    vi.mocked(QemuService.vmCreate).mockResolvedValue(cliOk("VM node1 created."));
    vi.mocked(QemuService.vmStart).mockResolvedValue(cliOk("QEMU started."));
    vi.mocked(QemuService.vmStop).mockResolvedValue(cliOk());
    vi.mocked(QemuService.vmDelete).mockResolvedValue(cliOk());
    vi.mocked(QemuService.vmSnapshot).mockResolvedValue(cliOk("snapshot created"));
    vi.mocked(QemuService.vmRestore).mockResolvedValue(cliOk("snapshot restored"));
    vi.mocked(QemuService.guestWait).mockResolvedValue(cliOk("guest SSH reachable after 1 attempt(s)."));
    vi.mocked(QemuService.redroidCreate).mockResolvedValue(
      cliOk("instance r1 created on VM node1.\n  adb serial: 127.0.0.1:24501"),
    );
    vi.mocked(QemuService.verify).mockResolvedValue(verifyFixture);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useAppStore.setState({ qemuSetup: null, qemuWaitVm: null });
  });

  it("marks the state dir as project-internal and hints the portable QEMU install", async () => {
    renderPage();
    await flushLoads();
    // Portable badge + note: everything lives in qemu-center/state.
    expect(screen.getByText("项目内")).toBeTruthy();
    expect(screen.getByText(/全部数据位于项目内/)).toBeTruthy();
    // The install-QEMU hint promises a portable, project-internal install.
    const installBtn = screen.getByRole("button", { name: "安装 QEMU" });
    expect(installBtn.getAttribute("title") || "").toContain("便携安装到项目内");
    // The one honest exception: WHPX is a Windows system feature.
    const whpxBtn = screen.getByRole("button", { name: "启用 WHPX" });
    expect(whpxBtn.getAttribute("title") || "").toContain("无法便携化");
  });

  it("renders doctor checks with ok/fail/unknown badges and the fix hint", async () => {
    renderPage();
    await flushLoads();
    expect(screen.getByText("WHPX feature")).toBeTruthy();
    expect(screen.getByText("缺失")).toBeTruthy(); // fail badge (zh)
    expect(screen.getByText("就绪")).toBeTruthy(); // ok badge (zh)
    expect(screen.getByText("未知")).toBeTruthy(); // unknown badge (zh)
    expect(screen.getByText(/qemu-center setup whpx/)).toBeTruthy(); // fix line
  });

  it("keeps the verify picker in the card body and shows an empty guide before the first run", async () => {
    renderPage();
    await flushLoads();
    // The node picker lives in the card body with its own label, not squeezed
    // into the header row next to the run button.
    expect(screen.getByLabelText("验收节点")).toBeTruthy();
    expect(screen.getByText("尚未运行验收。在上方选择节点，点击「运行验收」。")).toBeTruthy();
    // Long doctor details and the state-dir path are ellipsised but keep a
    // full-text tooltip so nothing overflows the card.
    expect(screen.getByTitle("HypervisorPlatform = Disabled")).toBeTruthy();
    expect(screen.getByTitle(doctorFixture.stateDir)).toBeTruthy();
  });

  it("renders the node table from vm list", async () => {
    renderPage();
    await flushLoads();
    // "node1" appears in both the table cell and the verify <option>.
    expect(screen.getAllByText("node1").length).toBeGreaterThan(0);
    expect(screen.getByText("24500..=24501")).toBeTruthy(); // adb block
    expect(screen.getByText("22300")).toBeTruthy(); // ssh port
    expect(screen.getByText("r1")).toBeTruthy(); // instance row from redroid list
    expect(screen.getByText("127.0.0.1:24500")).toBeTruthy();
  });

  it("one-click setup calls setup(all) and re-runs doctor", async () => {
    renderPage();
    await flushLoads();
    expect(QemuService.doctor).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "一键安装环境" }));
    await waitFor(() => expect(QemuService.setup).toHaveBeenCalledWith("all", "noble"));
    await waitFor(() => expect(QemuService.doctor).toHaveBeenCalledTimes(2));
  });

  it("restores the pending-setup banner and the step loading state on return", async () => {
    // Simulates coming back to the page while `setup all` still runs Rust-side.
    useAppStore
      .getState()
      .setQemuSetup({ running: true, step: "all", startedAt: Date.now() - 5 * 60_000 });
    renderPage();
    await flushLoads();

    const banner = document.querySelector(".qemu-setup-pending") as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain("环境安装进行中");
    expect(banner.textContent).toContain("一键安装环境"); // running step label
    expect(banner.textContent).toContain("5"); // elapsed minutes
    expect(banner.querySelector("button")?.textContent).toBe("重新体检");

    // The running step keeps its loading state ("...") and every setup button
    // is locked so a second `setup all` cannot be launched in parallel.
    const loadingButtons = screen
      .getAllByRole("button")
      .filter((el) => el.textContent === "..." && (el as HTMLButtonElement).disabled);
    expect(loadingButtons).toHaveLength(1);
    expect((screen.getByRole("button", { name: "启用 WHPX" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "安装 QEMU" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "下载镜像" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses a second setup while one is already running (re-entry guard)", async () => {
    const resolveSetup = deferredSetup();
    renderPage();
    await flushLoads();
    const setupBtn = screen.getByRole("button", { name: "一键安装环境" });

    // Both clicks land before React commits the disabled state: the guard must
    // read the global flag synchronously or winget/DISM would run twice.
    act(() => {
      setupBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      setupBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await waitFor(() => expect(screen.getByText(/已有环境安装任务进行中/)).toBeTruthy());
    expect(QemuService.setup).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSetup.resolve(cliOk());
      await Promise.resolve();
    });
    await waitFor(() => expect(useAppStore.getState().qemuSetup).toBeNull());
  });

  it("survives a page switch: the flag is global and setup is not restarted on return", async () => {
    const resolveSetup = deferredSetup();
    const first = renderPage();
    await flushLoads();
    fireEvent.click(screen.getByRole("button", { name: "一键安装环境" }));
    await waitFor(() => expect(useAppStore.getState().qemuSetup?.running).toBe(true));

    first.unmount(); // user switches to another page mid-install
    expect(useAppStore.getState().qemuSetup?.running).toBe(true);

    renderPage(); // ...and comes back
    await flushLoads();
    expect(screen.getByText(/环境安装进行中/)).toBeTruthy();
    expect(QemuService.setup).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSetup.resolve(cliOk("done"));
      await Promise.resolve();
    });
    await waitFor(() => expect(useAppStore.getState().qemuSetup).toBeNull());
    await waitFor(() => expect(screen.queryByText(/环境安装进行中/)).toBeNull());
  });

  it("clears the global flag on completion and re-runs doctor exactly once", async () => {
    renderPage();
    await flushLoads();
    expect(QemuService.doctor).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "一键安装环境" }));
    await waitFor(() => expect(QemuService.setup).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useAppStore.getState().qemuSetup).toBeNull());
    await waitFor(() => expect(QemuService.doctor).toHaveBeenCalledTimes(2));
  });

  it("polls doctor every 30s while the setup runs, then stops on unmount", async () => {
    vi.useFakeTimers();
    try {
      useAppStore.getState().setQemuSetup({ running: true, step: "image", startedAt: Date.now() });
      const view = renderPage();
      await flushLoads();
      expect(QemuService.doctor).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(QemuService.doctor).toHaveBeenCalledTimes(2);

      // Leaving the page stops the poll (no orphan timers writing state).
      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(QemuService.doctor).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an honest interrupted-wait hint after a page switch and can resume it", async () => {
    useAppStore.getState().setQemuWaitVm("node1");
    renderPage();
    await flushLoads();

    expect(screen.getByText(/等待已因切换页面中断/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "继续等待 SSH" }));
    await waitFor(() => expect(QemuService.guestWait).toHaveBeenCalledWith("node1", 15));
    // The resumed wait completes in the first chunk and clears the flag.
    await waitFor(() => expect(useAppStore.getState().qemuWaitVm).toBeNull());
  });

  it("submits the create-node form with the form values and auto-waits for guest SSH", async () => {
    renderPage();
    await flushLoads();
    fireEvent.click(screen.getByRole("button", { name: "创建节点" }));
    const nameInput = screen
      .getAllByDisplayValue("node1")
      .find((el) => el.tagName === "INPUT") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "node9" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并等待 SSH" }));
    await waitFor(() =>
      expect(QemuService.vmCreate).toHaveBeenCalledWith({
        name: "node9",
        imagePath: "",
        cpus: 4,
        memMib: 4096,
        diskGib: 40,
        adbPortCount: 32,
        autoSetup: true,
      }),
    );
    // The auto guest-wait polls in 15s chunks so it can be canceled.
    await waitFor(() =>
      expect(QemuService.guestWait).toHaveBeenCalledWith("node9", 15),
    );
  });

  it("surfaces the CLI stderr summary in the status line when node creation fails", async () => {
    // Real-world failure: the CLI never made <state>/keys before ssh-keygen,
    // and the page showed only a bare "failed" — the cause was buried in the
    // log panel, so the button felt dead.
    vi.mocked(QemuService.vmCreate).mockResolvedValue({
      success: false,
      exitCode: 1,
      stdout: "",
      stderr: "error: ssh-keygen failed: No such file or directory",
    });
    renderPage();
    await flushLoads();
    fireEvent.click(screen.getByRole("button", { name: "创建节点" }));
    fireEvent.click(screen.getByRole("button", { name: "创建并等待 SSH" }));
    // The status line itself must carry the stderr summary (the log panel
    // shows the full output too, so match the .qemu-status-line element).
    await waitFor(() => {
      const statusLine = document.querySelector(".qemu-status-line");
      expect(statusLine?.textContent).toContain("创建节点失败");
      expect(statusLine?.textContent).toContain("ssh-keygen failed");
    });
    // A failed create must not fall through into the auto guest-wait.
    expect(QemuService.guestWait).not.toHaveBeenCalled();
  });

  it("renders verify verdicts and explains that UNTESTED is not a failure", async () => {
    renderPage();
    await flushLoads();
    fireEvent.click(screen.getAllByRole("button", { name: "验收" })[0]);
    await waitFor(() => expect(QemuService.verify).toHaveBeenCalledWith("node1"));
    await waitFor(() => {
      expect(screen.getByText("PASS")).toBeTruthy();
      expect(screen.getByText("FAIL")).toBeTruthy();
      expect(screen.getByText("UNTESTED")).toBeTruthy();
    });
    expect(screen.getByText(/本机无法判定/)).toBeTruthy();
  });

  it("creates an instance with the form values and shows a copyable serial", async () => {
    const { copyText } = await import("../lib/clipboard");
    vi.mocked(QemuService.redroidList)
      .mockResolvedValueOnce(instancesFixture) // mount load
      .mockResolvedValueOnce([
        ...instancesFixture,
        { instance: "r2", container: "qc-r2", port: 24501, serial: "127.0.0.1:24501", status: "unknown" },
      ]); // after create
    renderPage();
    await flushLoads();
    // First click opens the form (header toggle); the submit button lives
    // inside the form, so pick the last matching button.
    fireEvent.click(screen.getAllByRole("button", { name: "创建实例" })[0]);
    const createButtons = screen.getAllByRole("button", { name: "创建实例" });
    fireEvent.click(createButtons[createButtons.length - 1]);
    await waitFor(() =>
      expect(QemuService.redroidCreate).toHaveBeenCalledWith(expect.objectContaining({
        vm: "node1",
        name: "r1",
        cpus: 1,
        memoryMib: 2048,
        width: 720,
        height: 1280,
        dpi: 320,
      })),
    );
    await waitFor(() => expect(screen.getByText("127.0.0.1:24501")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "复制 Serial" })[0]);
    await waitFor(() => expect(copyText).toHaveBeenCalled());
  });

  it("locks upgrade version and preserves runtime settings while surfacing failures", async () => {
    vi.mocked(QemuService.redroidList).mockResolvedValue([{ ...instancesFixture[0], androidVersion: "13", image: "redroid:13", rollbackAvailable: true }]);
    vi.mocked(QemuService.redroidUpgrade).mockResolvedValue({ success: false, exitCode: 1, stdout: "", stderr: "GApps architecture mismatch: arm64" });
    renderPage();
    await flushLoads();
    fireEvent.click(screen.getByRole("button", { name: "升级预装" }));
    expect(screen.getByLabelText("实例名称").getAttribute("value")).toBe("r1");
    expect((screen.getByLabelText("Android 版本") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/保留数据/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始升级" }));
    await waitFor(() => expect(QemuService.redroidUpgrade).toHaveBeenCalledWith(expect.objectContaining({ vm: "node1", name: "r1", androidVersion: "13" })));
    expect(QemuService.redroidCreate).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector(".qemu-status-line")?.textContent).toContain("GApps architecture mismatch: arm64"));
    expect(screen.getByLabelText("实例名称")).toBeTruthy();
  });

  it("requires Magisk for dependent presets and sends multiline module paths", async () => {
    renderPage();
    await flushLoads();
    fireEvent.click(screen.getAllByRole("button", { name: "创建实例" })[0]);
    await waitFor(() => expect((screen.getByLabelText("本地 GApps ZIP 路径") as HTMLInputElement).value).toBe("C:/assets/gapps.zip"));
    expect((screen.getByLabelText("LSPosed") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Magisk + Zygisk"));
    fireEvent.click(screen.getByLabelText("LSPosed"));
    fireEvent.click(screen.getByLabelText("DeviceCloak"));
    fireEvent.click(screen.getByLabelText("GApps（x86_64）"));
    fireEvent.change(screen.getByLabelText("额外模块 ZIP（每行一个路径）"), { target: { value: "C:/a.zip\n\n C:/b.zip " } });
    const buttons = screen.getAllByRole("button", { name: "创建实例" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(QemuService.redroidCreate).toHaveBeenCalledWith(expect.objectContaining({ installMagisk: true, installLsposed: true, installCloak: true, installGapps: true, gappsZip: "C:/assets/gapps.zip", moduleZips: ["C:/a.zip", "C:/b.zip"] })));
  });

  it("restores only instances with a saved upgrade rollback", async () => {
    vi.mocked(QemuService.redroidList).mockResolvedValue([{ ...instancesFixture[0], rollbackAvailable: true }]);
    vi.mocked(QemuService.redroidRestore).mockResolvedValue(cliOk());
    renderPage();
    await flushLoads();
    fireEvent.click(screen.getByRole("button", { name: "恢复升级前" }));
    await waitFor(() => expect(QemuService.redroidRestore).toHaveBeenCalledWith("node1", "r1"));
  });

  it("clears dependent options when Magisk is removed and accepts custom profile IDs", async () => {
    renderPage();
    await flushLoads();
    expect((screen.getByRole("button", { name: "恢复升级前" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "创建实例" })[0]);
    fireEvent.click(screen.getByLabelText("Magisk + Zygisk"));
    fireEvent.change(screen.getByLabelText("设备配置 ID（可选择或输入自定义 ID）"), { target: { value: "my-custom-phone" } });
    fireEvent.click(screen.getByLabelText("清理系统环境痕迹"));
    fireEvent.click(screen.getByLabelText("LSPosed"));
    fireEvent.click(screen.getByLabelText("Magisk + Zygisk"));
    expect((screen.getByLabelText("LSPosed") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("清理系统环境痕迹") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("设备配置 ID（可选择或输入自定义 ID）") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByLabelText("Magisk + Zygisk"));
    fireEvent.change(screen.getByLabelText("设备配置 ID（可选择或输入自定义 ID）"), { target: { value: "my-custom-phone" } });
    const buttons = screen.getAllByRole("button", { name: "创建实例" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(QemuService.redroidCreate).toHaveBeenCalledWith(expect.objectContaining({ spoofProfileId: "my-custom-phone" })));
  });

  it("prevents repeated upgrade submissions while installation is running", async () => {
    let complete!: (output: QemuCliOutput) => void;
    vi.mocked(QemuService.redroidUpgrade).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    renderPage();
    await flushLoads();
    fireEvent.click(screen.getByRole("button", { name: "升级预装" }));
    expect(screen.getByText(/后端会检查 Android 版本一致/)).toBeTruthy();
    const submit = screen.getByRole("button", { name: "开始升级" });
    act(() => {
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => expect(QemuService.redroidUpgrade).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/可能需要较长时间/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { complete(cliOk()); });
  });

  it("appends command lines to the collapsible log panel", async () => {
    renderPage();
    await flushLoads();
    fireEvent.click(screen.getAllByRole("button", { name: "验收" })[0]);
    await waitFor(() => expect(screen.getByText(/\$ qemu-center verify/)).toBeTruthy());
    const toggle = screen.getByRole("button", { name: "收起日志" });
    fireEvent.click(toggle);
    expect(screen.queryByText(/\$ qemu-center verify/)).toBeNull();
    expect(screen.getByRole("button", { name: "展开日志" })).toBeTruthy();
  });

  it("shows the CLI-missing banner when doctor fails", async () => {
    vi.mocked(QemuService.doctor).mockRejectedValue(new Error("spawn failed"));
    renderPage();
    await flushLoads();
    expect(screen.getByText(/未找到 qemu-center 可执行文件/)).toBeTruthy();
    expect(screen.getByText("spawn failed")).toBeTruthy();
  });

  it("wires node row actions to vmStart/vmStop/vmDelete", async () => {
    renderPage();
    await flushLoads();
    fireEvent.click(screen.getByRole("button", { name: "启动" }));
    await waitFor(() => expect(QemuService.vmStart).toHaveBeenCalledWith("node1"));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(QemuService.vmStop).toHaveBeenCalledWith("node1"));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(QemuService.vmDelete).toHaveBeenCalledWith("node1", true));
  });

  it("shows a failed VM launch in the status line", async () => {
    vi.mocked(QemuService.vmStart).mockResolvedValue({
      success: false, exitCode: 1, stdout: "", stderr: "QEMU failed to start: Image is corrupt",
    });
    const { container } = renderPage();
    await flushLoads();
    fireEvent.click(screen.getByRole("button", { name: "启动" }));
    await waitFor(() => expect(container.querySelector(".qemu-status-line")?.textContent)
      .toContain("QEMU failed to start: Image is corrupt"));
  });

  it("creates a snapshot from the node row after prompting for a tag", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("clean-1");
    renderPage();
    await flushLoads();
    fireEvent.click(screen.getByRole("button", { name: "快照" }));
    await waitFor(() => expect(QemuService.vmSnapshot).toHaveBeenCalledWith("node1", "clean-1"));
    expect(await screen.findByText("快照 clean-1 已创建")).toBeTruthy();
    promptSpy.mockRestore();
  });

  it("refuses a restore while the node has no snapshots", async () => {
    vi.mocked(QemuService.vmList).mockResolvedValue(vmsFixture); // no snapshots
    renderPage();
    await flushLoads();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await flushLoads();
    expect(screen.getByText("该节点还没有可恢复的快照，先点「快照」创建")).toBeTruthy();
    expect(QemuService.vmRestore).not.toHaveBeenCalled();
  });

  it("restores an existing snapshot after confirmation and tag prompt", async () => {
    vi.mocked(QemuService.vmList).mockResolvedValue([
      { ...vmsFixture[0], snapshots: ["clean-1", "v2"] },
    ]);
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("v2");
    renderPage();
    await flushLoads();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(QemuService.vmRestore).toHaveBeenCalledWith("node1", "v2"));
    expect(await screen.findByText("已恢复到快照 v2，启动 VM 后生效")).toBeTruthy();
    promptSpy.mockRestore();
  });
});
