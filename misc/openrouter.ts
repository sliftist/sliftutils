import { parseYAML } from "./yaml";
import { retryFunctional } from "socket-function/src/batching";
import { formatNumber } from "socket-function/src/formatting/format";
import { getAPIKey } from "./apiKeys";

export type MessageHistory = {
    role: "system" | "user" | "assistant";
    content: string;
}[];
export type MessageHistory2 = {
    role: "system" | "user" | "assistant";
    content: string | {
        type: "image_url";
        image_url: {
            url: string;
        };
    }[];
}[];

let totalCost = 0;
export function getTotalCost() {
    return totalCost;
}
type OpenRouterOptions = {
    provider?: {
        sort?: "throughput" | "price" | "latency",
        // https://openrouter.ai/docs/features/provider-routing#ordering-specific-providers
        order?: string[],
    }
    reasoningEffort?: "low" | "medium" | "high",
};
/** IMPORTANT! Make sure to tell the AI to return yaml. */
export async function yamlOpenRouterCall<T>(config: {
    model: string;
    messages: MessageHistory;
    retries?: number;
    options?: OpenRouterOptions;
    onCost?: (cost: number) => void;
    validate?: (response: T) => void;
}): Promise<T> {
    let { model, messages, retries = 3, options, onCost } = config;
    try {
        let response = await openRouterCall({ model, messages, options, onCost, retries: 0 });
        let result = parseYAML(response) as T;
        config.validate?.(result);
        return result;
    } catch (error) {
        if (retries > 0) {
            return yamlOpenRouterCall<T>({ model, messages, retries: retries - 1, onCost });
        }
        throw error;
    }
}

let pendingLog: {
    count: number;
    duration: number;
    cost: number;
} | undefined = undefined;

export async function openRouterCall(config: {
    model: string;
    messages: MessageHistory;
    options?: OpenRouterOptions;
    onCost?: (cost: number) => void;
    retries?: number;
}): Promise<string> {
    return await openRouterCallBase(config);
}

export async function openRouterCallBase(config: {
    model: string;
    messages: MessageHistory2;
    options?: OpenRouterOptions;
    onCost?: (cost: number) => void;
    retries?: number;
}): Promise<string> {
    let { model, messages, options, onCost } = config;
    let openrouterKey = await getAPIKey("openrouter.json");
    console.log(`Calling ${model} with ${messages.length} messages`);
    let time = Date.now();
    let stillRunning = true;

    // Spawn monitoring loop
    void (async () => {
        while (stillRunning) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            if (stillRunning) {
                console.log("OpenRouter call still running...");
            }
        }
    })();

    try {
        return await retryFunctional(async () => {
            let response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${openrouterKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model,
                    messages,
                    provider: {
                        sort: "throughput",
                    },
                    usage: { include: true },
                    ...options,
                }),
            });

            // If it failed, throw
            if (response.status !== 200) {
                let responseText = await response.text();
                throw new Error(`Failed to call OpenRouter: ${response.status} ${response.statusText} ${responseText}`);
            }
            let responseObj = await response.json() as {
                usage: {
                    cost: number;
                };
                choices: {
                    message: {
                        content: string;
                    };
                }[];
            };
            let newCost = responseObj.usage.cost;
            totalCost += newCost;
            onCost?.(newCost);
            if (!pendingLog) {
                pendingLog = {
                    count: 0,
                    duration: 0,
                    cost: 0,
                };
                setTimeout(() => {
                    let log = pendingLog;
                    if (!log) return;
                    console.log(`Ran: ${log.count} calls at a total summed cost of ${formatNumber(1 / log.cost)}/USD`);
                    pendingLog = undefined;
                }, 10_000);
            }
            pendingLog.count++;
            pendingLog.duration += Date.now() - time;
            pendingLog.cost += newCost;
            return responseObj.choices[0].message.content as string;
        }, { maxRetries: config.retries || 3 })();
    } finally {
        stillRunning = false;
    }
}
