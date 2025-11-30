# sliftutils

A build system and utility library for MobX + Preact projects.

## Getting Started

### 1. Setup

The first thing you should do is call the setup function. They will give you a lot of boilerplate code which you can delete or keep (I recommend commiting first, so you can pick which boilerplate changes you want):

```bash
npx slift-setup
# or
npx sliftsetup
```

### 2. Build or Watch

After setup, you can either **build** your project or **watch** for changes:

#### Build Commands
```bash
npx build-nodejs      # Build Node.js application
npx build-web         # Build web application
npx build-extension   # Build browser extension
npx build-electron    # Build Electron application
```

#### Watch Commands
```bash
npx slift-watch --port 9876 "nodejs/*.ts" "nodejs/*.tsx" "yarn build-nodejs"
npx slift-watch --port 9877 "web/*.ts" "web/*.tsx" "yarn build-web"
npx slift-watch --port 9878 "extension/*.ts" "extension/*.tsx" "yarn build-extension"
npx slift-watch --port 9879 "electron/*.ts" "electron/*.tsx" "yarn build-electron"
```

### 3. Run

After building, you can call the run functions:

```bash
node ./build-nodejs/server.js     # Run built Node.js app
node ./builders/webRun.js         # Run web application
node ./node_modules/electron/cli.js ./build-electron/electronMain.js  # Run Electron app
```

Or you can add your own scripts with special parameters if you want.

## Hot Reloading

### Optional Hot Reloading Function

You can optionally call the hot reloading function in your code if you want automatic reloading during development:

```typescript
import { enableHotReloading } from "sliftutils/builders/hotReload";

async function main() {
    await enableHotReloading();
    // Your application code here
}

main().catch(console.error);
```

### Running Node.js Scripts Directly

Node.js scripts can be called directly with **typenode** without needing to bundle them:

```bash
typenode ./nodejs/server.ts
```

When you call scripts directly with typenode, you can use hot reloading which allows you to hot reload per file by setting the `module.hotreload` flag or adding a `hotreload.flag` file.

#### Per-File Hot Reloading

To enable hot reloading for specific files, set the `module.hotreload` flag at the top of your file:

```typescript
// Either set this flag on the files you want to hot reload
module.hotreload = true;

export function exampleFunction() {
    return "Hello from exampleFile.ts";
}
```

Alternatively, you can add a file called `hotreload.flag` in a folder, and everything in that folder and all child files will hot reload.

See `nodejs/exampleFile.ts` for an example of how to use the hot reload flag.

## Utilities

This package includes many utilities for MobX + Preact projects. To see what utilities are available, read the `index.d.ts` file in the package. The utilities will work with any MobX + Preact type projects.

## License

MIT

