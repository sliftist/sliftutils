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
export declare function getTotalCost(): number;
type OpenRouterOptions = {
    provider?: {
        sort?: "throughput" | "price" | "latency";
        order?: string[];
    };
    reasoningEffort?: "low" | "medium" | "high";
};
/** IMPORTANT! Make sure to tell the AI to return yaml. */
export declare function yamlOpenRouterCall<T>(config: {
    model: string;
    messages: MessageHistory;
    retries?: number;
    options?: OpenRouterOptions;
    onCost?: (cost: number) => void;
    validate?: (response: T) => void;
}): Promise<T>;
export declare function openRouterCall(config: {
    model: string;
    messages: MessageHistory;
    options?: OpenRouterOptions;
    onCost?: (cost: number) => void;
    retries?: number;
}): Promise<string>;
export declare function openRouterCallBase(config: {
    model: string;
    messages: MessageHistory2;
    options?: OpenRouterOptions;
    onCost?: (cost: number) => void;
    retries?: number;
}): Promise<string>;
export {};
