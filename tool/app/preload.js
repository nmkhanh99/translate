// Preload cho cửa sổ Terminal: cầu nối an toàn (contextIsolation) giữa trang
// terminal.html (renderer, không có quyền Node) và main process (giữ node-pty).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ptyAPI", {
  // Tạo 1 PTY (shell đăng nhập) trong thư mục translate; trả về id (chuỗi).
  create: (opts) => ipcRenderer.invoke("pty:create", opts),
  write: (id, data) => ipcRenderer.send("pty:write", { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send("pty:resize", { id, cols, rows }),
  kill: (id) => ipcRenderer.send("pty:kill", { id }),
  // Nhận dữ liệu/thoát của PTY. Trả hàm huỷ đăng ký.
  onData: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on("pty:data", h);
    return () => ipcRenderer.removeListener("pty:data", h);
  },
  onExit: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on("pty:exit", h);
    return () => ipcRenderer.removeListener("pty:exit", h);
  },
});
