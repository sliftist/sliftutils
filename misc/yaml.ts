import * as yaml from "./yamlBase";

export function parseYAML(text: string): unknown {
    text = text.trim();
    if (text.startsWith("```yaml")) {
        text = text.slice("```yaml".length).trim();
    }
    if (text.endsWith("```")) {
        text = text.slice(0, -"```".length).trim();
    }
    text = text.trim();
    return yaml.parse(text);
}

export function stringifyYAML(value: unknown): string {
    return yaml.stringify(value);
}

