"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const pluginDir = path.resolve(__dirname, "..");
const rootDir = path.resolve(pluginDir, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(pluginDir, "package-lock.json"), "utf8"));

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

assert(manifest.Actions.length === 7, "The manifest must contain seven actions");
assert(new Set(manifest.Actions.map(function (action) { return action.UUID; })).size === 7,
    "Action UUIDs must be unique");
assert(manifest.Version === packageJson.version, "Manifest and package versions must match");
assert(packageJson.version === packageLock.version, "Package and lockfile versions must match");
assert(packageJson.version === packageLock.packages[""].version,
    "Lockfile root package version must match");

manifest.Actions.forEach(function (action) {
    assert(action.Controllers.includes("Information"), action.Name + " must support Information");
    assert(fs.existsSync(path.join(rootDir, action.Icon)), "Missing icon: " + action.Icon);
    assert(fs.existsSync(path.join(rootDir, action.PropertyInspectorPath)),
        "Missing property inspector: " + action.PropertyInspectorPath);
});

const keypadUUIDs = new Set([
    "com.karaar.macmonitor.cpu",
    "com.karaar.macmonitor.battery",
    "com.karaar.macmonitor.disk",
    "com.karaar.macmonitor.network"
]);
manifest.Actions.forEach(function (action) {
    assert(action.Controllers.includes("Keypad") === keypadUUIDs.has(action.UUID),
        "Incorrect Keypad support: " + action.UUID);
});

const syntax = spawnSync(process.execPath, ["--check", path.join(pluginDir, "index.js")], {
    encoding: "utf8"
});
assert(syntax.status === 0, syntax.stderr || "Plugin syntax check failed");

console.log("Validated 7 actions, controller mapping, assets, versions and plugin syntax.");
