import fs from "fs";
import path from "path";

export async function* getAllFiles(folder: string): AsyncIterableIterator<string> {
    const files = await fs.promises.readdir(folder);
    for (const file of files) {
        const filePath = path.join(folder, file);
        try {
            const stats = await fs.promises.stat(filePath);
            if (stats.isDirectory()) {
                yield* getAllFiles(filePath);
            } else {
                yield filePath;
            }
        } catch (error) {
            console.warn(`Failed while accessing path, skipping: ${filePath}`, error);
        }
    }
}