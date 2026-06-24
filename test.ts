import { yamlOpenRouterCall } from "./misc/openrouter";

async function main() {
    let test = await yamlOpenRouterCall({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: "" }],
    });
    console.log(test);
}
main().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => process.exit());