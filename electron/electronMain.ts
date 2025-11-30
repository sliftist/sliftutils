import { app, BrowserWindow } from "electron";
import { isInElectron } from "../misc/environment";

async function main() {
    if (!isInElectron()) {
        return;
    }

    await app.whenReady();

    const mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    await mainWindow.loadFile("./electron/electronIndex.html");
    mainWindow.webContents.openDevTools();

    app.on("window-all-closed", () => {
        app.quit();
    });
}

main().catch(console.error);

