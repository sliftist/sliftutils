import { app, BrowserWindow } from "electron";
import { isInElectron } from "../misc/environment";

function main() {
    if (!isInElectron()) {
        return;
    }

    app.whenReady().then(() => {
        const mainWindow = new BrowserWindow({
            width: 800,
            height: 600,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
            },
        });

        mainWindow.loadFile("./electronIndex.html");
        mainWindow.webContents.openDevTools();
    });

    app.on("window-all-closed", () => {
        app.quit();
    });
}

main();

