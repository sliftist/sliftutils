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
    apiKey?: string;
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
export declare function simpleAICall(model: string, message: string): Promise<string>;
/** The message must request the result to be returned in YAML (we automatically parse this and return an object). */
export declare function simpleAICallTyped<T>(model: string, message: string): Promise<T>;
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
