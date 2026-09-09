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
let latest = null;

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
        if (latest) {
            draw(msg.context, action, latest);
        } else {
            drawError(msg.context);
        }
    }

    if (msg.event === "willDisappear") {
        contexts.delete(msg.context);
    }
});

ws.on("error", function () {});

function startMacmon() {
    const bin = path.join(__dirname, "bin", "macmon");
    const proc = spawn(bin, ["pipe", "-i", "1000"]);
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
                    draw(context, action, latest);
                });
            } catch (e) {}
        }
    });

    proc.on("exit", function () {
        latest = null;
        contexts.forEach(function (action, context) {
            drawError(context);
        });
        setTimeout(startMacmon, 2000);
    });

    proc.on("error", function () {
        setTimeout(startMacmon, 2000);
    });
}

startMacmon();

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

    let c1, c2;
    if (stress < 55) {
        c1 = "#16d96f";
        c2 = "#7df52f";
    } else if (stress < 75) {
        c1 = "#8cf12f";
        c2 = "#ffae19";
    } else {
        c1 = "#ff9b16";
        c2 = "#ff4949";
    }

    const c = createCanvas(144, 144);
    const x = c.getContext("2d");

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

    x.fillStyle = "#000";
    x.textAlign = "center";

    x.font = "bold 25px Arial";
    x.fillText(title, 72, 34);

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
    process.exit(0);
});
process.on("SIGINT", function () {
    process.exit(0);
});
