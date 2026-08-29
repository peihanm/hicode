const os = require("node:os");

const originalUserInfo = os.userInfo;

os.userInfo = function patchedUserInfo(options) {
    try {
        return originalUserInfo.call(os, options);
    } catch (err) {
        const code = err && typeof err === "object" ? err.code : undefined;
        const infoCode =
            err && typeof err === "object" && err.info ? err.info.code : undefined;
        if (code !== "ENOENT" && infoCode !== "ENOENT") {
            throw err;
        }

        const uid = typeof process.getuid === "function" ? process.getuid() : -1;
        const gid = typeof process.getgid === "function" ? process.getgid() : -1;
        return {
            uid,
            gid,
            username: process.env.USER || process.env.LOGNAME || `uid-${uid}`,
            homedir: process.env.HOME || process.cwd(),
            shell: process.env.SHELL || "/bin/sh",
        };
    }
};
