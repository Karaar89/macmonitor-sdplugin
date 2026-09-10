"use strict";

const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { createCanvas } = require("@napi-rs/canvas");

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith("-")) {
            args[argv[i].slice(1)] = argv[i + 1];
            i++;
        }
    }
    return args;
}

const args = parseArgs(process.argv.slice(2));
const port = args.port;
const pluginUUID = args.pluginUUID;
const registerEvent = args.registerEvent;

const contexts = new Map();
const contextSettings = new Map();
let latest = null;
let macmonProc = null;
let battery = null;
let memory = null;
let storages = [];
let storageIndex = 0;
let network = null;
let networkPrevious = null;
let flashOn = false;
let performanceView = 0;
const lastPress = new Map();

const ws = new WebSocket("ws://127.0.0.1:" + port);

ws.on("open", function () {
    ws.send(JSON.stringify({ event: registerEvent, uuid: pluginUUID }));
});

ws.on("message", function (data) {
    let msg;
    try {
        msg = JSON.parse(data);
    } catch (e) {
        return;
    }

    if (msg.event === "willAppear") {
        const action = msg.action || "";
        contexts.set(msg.context, action);
        contextSettings.set(msg.context, (msg.payload && msg.payload.settings) || {});
        ws.send(JSON.stringify({ event: "getSettings", context: msg.context }));
        render(msg.context, action);
    }

    if (msg.event === "didReceiveSettings") {
        contextSettings.set(msg.context, (msg.payload && msg.payload.settings) || {});
        render(msg.context, contexts.get(msg.context) || msg.action || "");
    }

    if (msg.event === "keyDown" || msg.event === "keyUp") {
        handlePress(msg);
    }

    if (msg.event === "willDisappear") {
        contexts.delete(msg.context);
        contextSettings.delete(msg.context);
        lastPress.delete(msg.context);
    }
});

ws.on("error", function () {});

function handlePress(msg) {
    const context = msg.context || "";
    const now = Date.now();
    if (now - (lastPress.get(context) || 0) < 400) return;
    lastPress.set(context, now);
    openDestination(msg.action || contexts.get(context) || "");
}

function openDestination(action) {
    if (action.includes(".battery")) {
        spawn("/usr/bin/open", ["x-apple.systempreferences:com.apple.Battery-Settings.extension"]);
    } else if (action.includes(".disk")) {
        spawn("/usr/bin/open", ["x-apple.systempreferences:com.apple.settings.Storage"]);
    } else if (action.includes(".gpu")) {
        openActivityMonitor("GPU History", true);
    } else if (action.includes(".graphics")) {
        openActivityMonitor("GPU History", true);
    } else if (action.includes(".processor")) {
        openActivityMonitor("CPU", false);
    } else if (action.includes(".ram")) {
        openActivityMonitor("Memory", false);
    } else if (action.includes(".cpu")) {
        if (performanceView === 1) {
            openActivityMonitor("GPU History", true);
        } else if (performanceView === 2) {
            openActivityMonitor("Memory", false);
        } else {
            openActivityMonitor("CPU", false);
        }
    } else if (action.includes(".network")) {
        openActivityMonitor("Network", false);
    }
}

function openActivityMonitor(view, menuItem) {
    spawn("/usr/bin/open", ["-a", "Activity Monitor"]);
    const script = menuItem
        ? 'tell application "System Events" to tell process "Activity Monitor" to click menu item "' + view + '" of menu "Window" of menu bar 1'
        : 'tell application "System Events" to tell process "Activity Monitor" to click radio button "' + view + '" of radio group 1 of toolbar 1 of window 1';
    const proc = spawn("/usr/bin/osascript", ["-e", 'tell application "Activity Monitor" to activate', "-e", "delay 0.8", "-e", script]);
    proc.on("error", function () {});
}

function render(context, action) {
    if (action.includes(".battery")) {
        if (battery) {
            drawBattery(context);
        } else {
            drawError(context);
        }
        return;
    }
    if (action.includes(".disk")) {
        const storage = storages[storageIndex % storages.length];
        storage ? drawStorage(context, storage) : drawError(context);
        return;
    }
    if (action.includes(".network")) {
        network ? drawNetwork(context) : drawError(context);
        return;
    }
    if (action.includes(".ram")) {
        memory ? drawGauge(context, "RAM", memory.usedPct, "FREE", formatBytes(memory.available)) : drawError(context);
        return;
    }
    if (action.includes(".processor")) {
        latest ? draw(context, action.replace(".processor", ".cpu"), latest) : drawError(context);
        return;
    }
    if (action.includes(".graphics")) {
        latest ? draw(context, action.replace(".graphics", ".gpu"), latest) : drawError(context);
        return;
    }
    if (action.includes(".cpu") && performanceView === 2) {
        memory ? drawGauge(context, "RAM", memory.usedPct, "FREE", formatBytes(memory.available)) : drawError(context);
        return;
    }
    if (latest) {
        const displayAction = action.includes(".cpu") && performanceView === 1
            ? action.replace(".cpu", ".gpu")
            : action;
        draw(context, displayAction, latest);
    } else {
        drawError(context);
    }
}

function numberSetting(context, key, fallback) {
    const value = Number((contextSettings.get(context) || {})[key]);
    return Number.isFinite(value) ? value : fallback;
}

function isProcessorAction(action) {
    return action.includes(".cpu") || action.includes(".gpu")
        || action.includes(".processor") || action.includes(".graphics");
}

function startMacmon() {
    const bin = path.join(__dirname, "bin", "macmon");
    const proc = spawn(bin, ["pipe", "-i", "1000"]);
    macmonProc = proc;
    let buffer = "";

    proc.stdout.on("data", function (chunk) {
        buffer += chunk.toString();
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            try {
                latest = JSON.parse(line);
                contexts.forEach(function (action, context) {
                    if (isProcessorAction(action)) {
                        render(context, action);
                    }
                });
            } catch (e) {}
        }
    });

    proc.on("exit", function () {
        if (macmonProc === proc) macmonProc = null;
        latest = null;
        contexts.forEach(function (action, context) {
            if (isProcessorAction(action)) {
                drawError(context);
            }
        });
        setTimeout(startMacmon, 2000);
    });

    proc.on("error", function () {
        setTimeout(startMacmon, 2000);
    });
}

startMacmon();

function pollBattery() {
    const proc = spawn("pmset", ["-g", "batt"]);
    let out = "";

    proc.stdout.on("data", function (chunk) {
        out += chunk.toString();
    });

    proc.on("error", function () {});

    proc.on("close", function () {
        const pctMatch = out.match(/(\d+)%/);
        if (!pctMatch) {
            battery = null;
            contexts.forEach(function (action, context) {
                if (action.includes(".battery")) {
                    drawError(context);
                }
            });
            return;
        }
        const pct = parseInt(pctMatch[1], 10);

        let state = "";
        const stateMatch = out.match(/\d+%;\s*([^;]+);/);
        if (stateMatch) state = stateMatch[1].trim().toLowerCase();

        let timeRemaining = null;
        const timeMatch = out.match(/(\d+:\d\d)\s+(?:remaining|until full)/);
        if (timeMatch && timeMatch[1] !== "0:00") timeRemaining = timeMatch[1];

        const charging = (state.indexOf("finishing charge") >= 0)
            || (state.indexOf("charging") >= 0
                && state.indexOf("discharging") < 0
                && state.indexOf("not charging") < 0);
        const plugged = charging || state.indexOf("charged") >= 0
            || state.indexOf("ac ") >= 0 || out.indexOf("AC Power") >= 0;

        battery = {
            pct: pct,
            charging: charging,
            plugged: plugged,
            timeRemaining: timeRemaining
        };

        contexts.forEach(function (action, context) {
            if (action.includes(".battery")) {
                drawBattery(context);
            }
        });
    });
}

setInterval(pollBattery, 10000);
pollBattery();

function capture(command, commandArgs, callback) {
    const proc = spawn(command, commandArgs);
    let out = "";
    let finished = false;
    function finish(value) {
        if (finished) return;
        finished = true;
        callback(value);
    }
    proc.stdout.on("data", function (chunk) { out += chunk.toString(); });
    proc.on("error", function () { finish(null); });
    proc.on("close", function (code) { finish(code === 0 ? out : null); });
}

function pollMemory() {
    capture("vm_stat", [], function (out) {
        if (!out) return;
        const pageMatch = out.match(/page size of (\d+) bytes/);
        const pageSize = pageMatch ? Number(pageMatch[1]) : 4096;
        const pages = {};
        out.replace(/^Pages ([^:]+):\s+(\d+)\./gm, function (_, name, value) {
            pages[name] = Number(value);
            return _;
        });
        const availablePages = (pages.free || 0) + (pages.inactive || 0) + (pages.speculative || 0);
        capture("sysctl", ["-n", "hw.memsize"], function (totalOut) {
            const total = Number(totalOut);
            if (!total) return;
            const available = Math.min(total, availablePages * pageSize);
            memory = { available: available, usedPct: Math.round((1 - available / total) * 100) };
            if (performanceView === 2) renderMatching(".cpu");
            renderMatching(".ram");
        });
    });
}

function pollStorage() {
    capture("df", ["-kP"], function (out) {
        if (!out) return;
        const mounted = [];
        out.split("\n").slice(1).forEach(function (line) {
            const match = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
            if (!match) return;
            const device = match[1];
            const mountPoint = match[6].trim();
            const isMacData = mountPoint === "/System/Volumes/Data";
            const isExternalVolume = mountPoint.startsWith("/Volumes/");
            if (!device.startsWith("/dev/") || (!isMacData && !isExternalVolume)) return;
            const name = isMacData ? "MAC" : path.basename(mountPoint);
            mounted.push({ name: name.toUpperCase(), available: Number(match[4]) * 1024, usedPct: Number(match[5]) });
        });
        storages = mounted;
        if (storageIndex >= storages.length) storageIndex = 0;
        renderMatching(".disk");
    });
}

function pollNetwork() {
    capture("netstat", ["-ibn"], function (out) {
        if (!out) return;
        let received = 0;
        let sent = 0;
        out.split("\n").forEach(function (line) {
            if (!/^\w+\s+\d+\s+<Link#/.test(line) || /^lo\d/.test(line)) return;
            const cols = line.trim().split(/\s+/);
            const inBytes = Number(cols[cols.length - 5]);
            const outBytes = Number(cols[cols.length - 2]);
            if (Number.isFinite(inBytes)) received += inBytes;
            if (Number.isFinite(outBytes)) sent += outBytes;
        });
        const now = Date.now();
        if (networkPrevious) {
            const seconds = Math.max(0.1, (now - networkPrevious.time) / 1000);
            network = {
                down: Math.max(0, (received - networkPrevious.received) / seconds),
                up: Math.max(0, (sent - networkPrevious.sent) / seconds)
            };
            renderMatching(".network");
        }
        networkPrevious = { received: received, sent: sent, time: now };
    });
}

function renderMatching(suffix) {
    contexts.forEach(function (action, context) {
        if (action.includes(suffix)) render(context, action);
    });
}

setInterval(pollMemory, 2000);
setInterval(pollStorage, 10000);
setInterval(pollNetwork, 1000);
pollMemory();
pollStorage();

setInterval(function () {
    performanceView = (performanceView + 1) % 3;
    if (storages.length > 1) storageIndex = (storageIndex + 1) % storages.length;
    renderMatching(".cpu");
    renderMatching(".disk");
}, 3000);
pollNetwork();

// Alerting keys alternate between their two warning colors every third of a second.
setInterval(function () {
    flashOn = !flashOn;
    contexts.forEach(function (action, context) {
        if (isAlertActive(context, action)) {
            render(context, action);
        }
    });
}, 333);

function isAlertActive(context, action) {
    if (action.includes(".battery")) {
        return battery && !battery.charging
            && battery.pct <= numberSetting(context, "batteryAlert", 20);
    }
    if (!latest || !isProcessorAction(action)) return false;
    if (action.includes(".ram")) return false;
    if (action.includes(".cpu") && performanceView === 2) return false;
    const showGPU = action.includes(".gpu") || action.includes(".graphics")
        || (action.includes(".cpu") && performanceView === 1);
    const temp = showGPU ? latest.temp.gpu_temp_avg : latest.temp.cpu_temp_avg;
    return temp >= numberSetting(context, "temperatureAlert", 80);
}

function sendImage(context, canvas) {
    ws.send(JSON.stringify({
        event: "setImage",
        context: context,
        payload: {
            target: 0,
            image: canvas.toDataURL("image/png")
        }
    }));
}

function panel(x, c1, c2) {
    const g = x.createLinearGradient(0, 144, 144, 0);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    x.fillStyle = g;

    const r = 20;
    x.beginPath();
    x.moveTo(r, 0);
    x.lineTo(144 - r, 0);
    x.quadraticCurveTo(144, 0, 144, r);
    x.lineTo(144, 144 - r);
    x.quadraticCurveTo(144, 144, 144 - r, 144);
    x.lineTo(r, 144);
    x.quadraticCurveTo(0, 144, 0, 144 - r);
    x.lineTo(0, r);
    x.quadraticCurveTo(0, 0, r, 0);
    x.closePath();
    x.fill();
}

function draw(context, action, data) {
    const cpu = Math.round(data.cpu_usage_pct * 100);
    const gpu = Math.round(data.gpu_scaled_ratio * 100);
    const cpuTemp = Math.round(data.temp.cpu_temp_avg);
    const gpuTemp = Math.round(data.temp.gpu_temp_avg);

    const isGPU = action.includes(".gpu");
    const usage = isGPU ? gpu : cpu;
    const temp = isGPU ? gpuTemp : cpuTemp;
    const title = isGPU ? "GPU" : "CPU";

    const stress = Math.max(usage, temp);
    const warningAt = numberSetting(context, "warningAt", 55);
    const criticalAt = numberSetting(context, "criticalAt", 75);
    const temperatureAlert = numberSetting(context, "temperatureAlert", 80);

    let c1, c2;
    if (temp >= temperatureAlert) {
        c1 = flashOn ? "#ff4949" : "#ff9b16";
        c2 = flashOn ? "#7a0011" : "#ff4949";
    } else if (stress < warningAt) {
        c1 = "#16d96f";
        c2 = "#7df52f";
    } else if (stress < criticalAt) {
        c1 = "#8cf12f";
        c2 = "#ffae19";
    } else {
        c1 = "#ff9b16";
        c2 = "#ff4949";
    }

    const c = createCanvas(144, 144);
    const x = c.getContext("2d");

    panel(x, c1, c2);

    x.fillStyle = "#000";
    x.textAlign = "center";

    x.font = "bold 25px Arial";
    x.fillText(title, 72, 34, 116);

    x.font = "bold 42px Arial";
    x.fillText(usage + "%", 72, 82);

    x.globalAlpha = 0.35;
    x.fillRect(16, 94, 112, 2);
    x.globalAlpha = 1;

    x.textAlign = "left";
    x.font = "bold 17px Arial";
    x.fillText("TEMP", 14, 123);

    x.textAlign = "right";
    x.fillText(temp + "°C", 132, 123);

    sendImage(context, c);
}

function drawBattery(context) {
    const b = battery;
    const level = b.pct;

    const lowBatteryAlert = numberSetting(context, "batteryAlert", 20);
    const warningBattery = numberSetting(context, "batteryWarning", 50);

    let c1, c2;
    if (b.charging) {
        c1 = "#16d96f";
        c2 = "#2fe0f5";
    } else if (level <= lowBatteryAlert) {
        c1 = flashOn ? "#ff4949" : "#ff9b16";
        c2 = flashOn ? "#7a0011" : "#ff4949";
    } else if (level > warningBattery) {
        c1 = "#16d96f";
        c2 = "#7df52f";
    } else if (level > lowBatteryAlert) {
        c1 = "#8cf12f";
        c2 = "#ffae19";
    } else {
        c1 = "#ff9b16";
        c2 = "#ff4949";
    }

    const c = createCanvas(144, 144);
    const x = c.getContext("2d");

    panel(x, c1, c2);

    x.fillStyle = "#000";
    x.textAlign = "center";

    x.font = "bold 25px Arial";
    x.fillText(b.charging ? "CHG" : "BATT", 72, 34);

    x.font = "bold 42px Arial";
    x.fillText(level + "%", 72, 82);

    x.globalAlpha = 0.35;
    x.fillRect(16, 94, 112, 2);
    x.globalAlpha = 1;

    let leftLabel, rightLabel;
    if (b.charging) {
        leftLabel = "TO FULL";
        rightLabel = b.timeRemaining || "--";
    } else if (b.timeRemaining) {
        leftLabel = "LEFT";
        rightLabel = b.timeRemaining;
    } else {
        leftLabel = "POWER";
        rightLabel = b.plugged ? "AC" : "--";
    }

    x.textAlign = "left";
    x.font = "bold 17px Arial";
    x.fillText(leftLabel, 14, 123);

    x.textAlign = "right";
    x.fillText(rightLabel, 132, 123);

    sendImage(context, c);
}

function formatBytes(bytes, fixedDigits) {
    if (!Number.isFinite(bytes)) return "--";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    const digits = fixedDigits === undefined ? (value >= 10 || unit === 0 ? 0 : 1) : fixedDigits;
    return value.toFixed(digits) + units[unit];
}

function drawGauge(context, title, value, detailLabel, detailValue) {
    const warningAt = numberSetting(context, "warningAt", 55);
    const criticalAt = numberSetting(context, "criticalAt", 75);
    let c1 = "#16d96f";
    let c2 = "#7df52f";
    if (value >= criticalAt) {
        c1 = "#ff9b16";
        c2 = "#ff4949";
    } else if (value >= warningAt) {
        c1 = "#8cf12f";
        c2 = "#ffae19";
    }

    const c = createCanvas(144, 144);
    const x = c.getContext("2d");
    panel(x, c1, c2);
    x.fillStyle = "#000";
    x.textAlign = "center";
    x.font = "bold 25px Arial";
    x.fillText(title, 72, 34, 116);
    x.font = "bold 42px Arial";
    x.fillText(Math.round(value) + "%", 72, 82);
    x.globalAlpha = 0.35;
    x.fillRect(16, 94, 112, 2);
    x.globalAlpha = 1;
    x.font = "bold 16px Arial";
    x.textAlign = "left";
    x.fillText(detailLabel, 14, 123);
    x.textAlign = "right";
    x.fillText(detailValue, 132, 123);
    sendImage(context, c);
}

function drawStorage(context, storage) {
    const warningAt = numberSetting(context, "warningAt", 55);
    const criticalAt = numberSetting(context, "criticalAt", 75);
    let c1 = "#16d96f";
    let c2 = "#7df52f";
    if (storage.usedPct >= criticalAt) {
        c1 = "#ff9b16";
        c2 = "#ff4949";
    } else if (storage.usedPct >= warningAt) {
        c1 = "#8cf12f";
        c2 = "#ffae19";
    }

    const c = createCanvas(144, 144);
    const x = c.getContext("2d");
    panel(x, c1, c2);
    x.fillStyle = "#000";
    x.textAlign = "center";
    x.font = "bold 22px Arial";
    x.fillText(storage.name, 72, 28, 116);
    x.font = "bold 25px Arial";
    x.fillText(Math.round(storage.usedPct) + "%", 72, 60);
    x.globalAlpha = 0.35;
    x.fillRect(16, 72, 112, 2);
    x.globalAlpha = 1;
    x.font = "bold 14px Arial";
    x.fillText("FREE", 72, 94);
    x.font = "bold 29px Arial";
    x.fillText(formatBytes(storage.available, 2), 72, 127, 120);
    sendImage(context, c);
}

function drawNetwork(context) {
    const c = createCanvas(144, 144);
    const x = c.getContext("2d");
    panel(x, "#16a7d9", "#2fe0f5");
    x.fillStyle = "#000";
    x.textAlign = "center";
    x.font = "bold 22px Arial";
    x.fillText("NETWORK", 72, 30);
    x.textAlign = "left";
    x.font = "bold 17px Arial";
    x.fillText("DOWN", 12, 63);
    x.fillText("UP", 12, 103);
    x.textAlign = "right";
    x.font = "bold 18px Arial";
    x.fillText(formatBytes(network.down) + "/s", 134, 63);
    x.fillText(formatBytes(network.up) + "/s", 134, 103);
    sendImage(context, c);
}

function drawError(context) {
    const c = createCanvas(144, 144);
    const x = c.getContext("2d");

    x.fillStyle = "#0b0f14";
    x.fillRect(0, 0, 144, 144);

    x.fillStyle = "#ffffff";
    x.font = "bold 18px Arial";
    x.textAlign = "center";
    x.fillText("MAC MONITOR", 72, 55);

    x.fillStyle = "#ff6666";
    x.font = "14px Arial";
    x.fillText("NO DATA", 72, 85);

    sendImage(context, c);
}

process.on("SIGTERM", function () {
    if (macmonProc) macmonProc.kill();
    process.exit(0);
});
process.on("SIGINT", function () {
    if (macmonProc) macmonProc.kill();
    process.exit(0);
});
