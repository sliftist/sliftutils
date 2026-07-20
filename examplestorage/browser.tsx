module.allowclient = true;

import preact from "preact";
import { observable } from "mobx";
import { observer } from "../render-utils/observer";
import { isNode } from "socket-function/src/misc";
import { delay } from "socket-function/src/batching";
import { formatNumber, formatDateTime } from "socket-function/src/formatting/format";
import { css } from "typesafecss";
import { InputLabel } from "../render-utils/InputLabel";
import { redButton, greenButton, errorMessage } from "../render-utils/colors";
import { createArchives } from "../storage/remoteStorage/createArchives";
import { ArchiveFileInfo } from "../storage/IArchives";

// The bucket's routing URL: server, account ("example"), and bucket ("examplefiles") in one. Nothing else is needed - the first call creates the bucket if it doesn't exist yet.
const STORAGE_URL = "https://storage.vidgridweb.com:4444/file/example/examplefiles/storage/storagerouting.json";
const ACCESS_CHECK_INTERVAL = 1000 * 15;

const archives = createArchives(STORAGE_URL);

@observer
class ExampleStoragePage extends preact.Component {
    synced = observable({
        files: [] as ArchiveFileInfo[],
        loaded: false,
        selectedPath: "",
        content: "",
        contentLoaded: false,
        newFileName: "",
        access: undefined as { link: string; machineId: string; ip: string } | undefined,
        error: "",
    });

    componentDidMount() {
        void (async () => {
            while (true) {
                let access = await archives.waitingForAccess();
                this.synced.access = access;
                if (!access) break;
                await delay(ACCESS_CHECK_INTERVAL);
            }
            await this.refresh();
        })();
    }

    private async refresh() {
        try {
            this.synced.files = await archives.findInfo("", { type: "files" });
            this.synced.loaded = true;
            this.synced.error = "";
        } catch (e) {
            this.synced.error = String(e);
        }
    }

    private async openFile(path: string) {
        this.synced.selectedPath = path;
        this.synced.contentLoaded = false;
        let data = await archives.get(path);
        this.synced.content = data && data.toString() || "";
        this.synced.contentLoaded = true;
    }

    private async createFile() {
        let name = this.synced.newFileName.trim();
        if (!name) return;
        await archives.set(name, Buffer.from(""));
        this.synced.newFileName = "";
        await this.refresh();
        await this.openFile(name);
    }

    private async deleteFile(path: string) {
        await archives.del(path);
        if (this.synced.selectedPath === path) {
            this.synced.selectedPath = "";
            this.synced.content = "";
            this.synced.contentLoaded = false;
        }
        await this.refresh();
    }

    render() {
        let synced = this.synced;
        return <div className={css.vbox(12).pad2(16)}>
            <div>Storage example site. Bucket {STORAGE_URL}</div>
            {synced.error && <div className={errorMessage}>{synced.error}</div>}
            {!synced.loaded && !synced.access && <div>Loading files...</div>}
            {!synced.loaded && synced.access && <div className={css.vbox(8)}>
                <div>This machine does not have access to the account yet.</div>
                <div>Machine: {synced.access.machineId}</div>
                <div>IP: {synced.access.ip}</div>
                <a href={synced.access.link} target="_blank">{synced.access.link}</a>
            </div>}
            {synced.loaded && <div className={css.hbox(24).alignItems("flex-start")}>
                <div className={css.vbox(8)}>
                    {synced.files.length === 0 && <div>No files yet</div>}
                    {synced.files.map(file => <div key={file.path} className={css.hbox(8).alignItems("center")}>
                        <button onClick={async () => this.openFile(file.path)}>
                            {file.path}
                        </button>
                        <div>{formatNumber(file.size)}B, {formatDateTime(file.createTime)}</div>
                        <button className={redButton} onClick={async () => this.deleteFile(file.path)}>
                            Delete
                        </button>
                    </div>)}
                    <div className={css.hbox(8).alignItems("center")}>
                        <InputLabel
                            label="New file"
                            hot
                            value={synced.newFileName}
                            onChangeValue={value => { synced.newFileName = value; }}
                        />
                        <button className={greenButton} onClick={async () => this.createFile()}>
                            Create
                        </button>
                    </div>
                </div>
                {synced.selectedPath && <div className={css.vbox(8).flexGrow(1)}>
                    <div>Editing {synced.selectedPath}</div>
                    {!synced.contentLoaded && <div>Loading content...</div>}
                    {synced.contentLoaded && <InputLabel
                        textarea
                        fillWidth
                        value={synced.content}
                        onChangeValue={async value => {
                            await archives.set(synced.selectedPath, Buffer.from(value));
                            synced.content = value;
                            await this.refresh();
                        }}
                    />}
                </div>}
            </div>}
        </div>;
    }
}

async function main() {
    if (isNode()) return;
    preact.render(<ExampleStoragePage />, document.body);
}

main().catch(console.error);
