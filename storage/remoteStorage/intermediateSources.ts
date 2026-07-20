import { RemoteConfig, RemoteConfigBase, HostedConfig, BackblazeConfig } from "../IArchives";

export const INTERMEDIATE_EXPIRE_GRACE = 15 * 60 * 1000;
const INTERMEDIATE_VERSION_FRACTION = 1_000_000;

/** Adding or removing intermediates is a real config update, so it takes a real version increment - but a proportional one, so it stays far below whatever the author's next version would be (whether they count 1, 2, 3 or use timestamps), and a million of them still fit under it. */
export function nextIntermediateVersion(version: number): number {
    let step = Math.abs(version) / INTERMEDIATE_VERSION_FRACTION;
    if (!(step > 0)) {
        step = 1 / INTERMEDIATE_VERSION_FRACTION;
    }
    return version + step;
}

type ObjectSource = HostedConfig | BackblazeConfig;

function isObjectSource(source: RemoteConfigBase): source is ObjectSource {
    return typeof source !== "string";
}

function cloneSource(source: RemoteConfigBase): RemoteConfigBase {
    if (!isObjectSource(source)) return source;
    return { ...source, validWindow: [source.validWindow[0], source.validWindow[1]] };
}

function joinKey(source: ObjectSource): string {
    return JSON.stringify({ ...source, validWindow: undefined });
}

export function getIntermediateSources(config: RemoteConfig): ObjectSource[] {
    return config.sources.filter(x => isObjectSource(x) && x.intermediate) as ObjectSource[];
}

export function hasIntermediateSources(config: RemoteConfig): boolean {
    return config.sources.some(x => isObjectSource(x) && x.intermediate);
}

/** Removes every intermediate entry and rejoins the windows it split, giving back the underlying configuration. Two configs that resolve equal differ only by intermediates. */
export function resolveIntermediateSources(config: RemoteConfig): RemoteConfig {
    if (!hasIntermediateSources(config)) return config;
    let removed = getIntermediateSources(config);
    let sources = config.sources.filter(x => !isObjectSource(x) || !x.intermediate).map(cloneSource);
    for (let gap of removed) {
        let [gapStart, gapEnd] = gap.validWindow;
        let before = sources.find(x => isObjectSource(x) && x.validWindow[1] === gapStart) as ObjectSource | undefined;
        let after = sources.find(x => isObjectSource(x) && x.validWindow[0] === gapEnd) as ObjectSource | undefined;
        if (before && after && joinKey(before) === joinKey(after)) {
            before.validWindow = [before.validWindow[0], after.validWindow[1]];
            sources.splice(sources.indexOf(after), 1);
            continue;
        }
        if (before) {
            before.validWindow = [before.validWindow[0], gapEnd];
            continue;
        }
        if (after) {
            after.validWindow = [gapStart, after.validWindow[1]];
        }
    }
    return { version: config.version, sources };
}

/** Splits every source at splitUrl covering [start, end) so that middle window points at intermediateUrl instead, flagged as intermediate. Idempotent: a config that already contains the exact intermediate comes back unchanged. */
export function injectIntermediateSource(config: RemoteConfig, inject: { splitUrl: string; intermediateUrl: string; start: number; end: number }): RemoteConfig {
    let { splitUrl, intermediateUrl, start, end } = inject;
    if (start >= end) return config;
    if (config.sources.some(x => isObjectSource(x) && x.intermediate && x.url === intermediateUrl && x.validWindow[0] === start && x.validWindow[1] === end)) {
        return config;
    }
    let sources: RemoteConfigBase[] = [];
    for (let source of config.sources) {
        if (!isObjectSource(source) || source.url !== splitUrl || source.intermediate) {
            sources.push(cloneSource(source));
            continue;
        }
        let [windowStart, windowEnd] = source.validWindow;
        if (windowEnd <= start || windowStart >= end) {
            sources.push(cloneSource(source));
            continue;
        }
        let middleStart = Math.max(windowStart, start);
        let middleEnd = Math.min(windowEnd, end);
        if (middleStart > windowStart) {
            sources.push({ ...source, validWindow: [windowStart, middleStart] });
        }
        sources.push({ ...source, url: intermediateUrl, validWindow: [middleStart, middleEnd], intermediate: true });
        if (windowEnd > middleEnd) {
            sources.push({ ...source, validWindow: [middleEnd, windowEnd] });
        }
    }
    return { version: config.version, sources };
}

/** Intermediates whose window ended more than INTERMEDIATE_EXPIRE_GRACE ago are removed, and the windows they split are rejoined. */
export function expireIntermediateSources(config: RemoteConfig, now: number): RemoteConfig {
    let expired = getIntermediateSources(config).filter(x => x.validWindow[1] + INTERMEDIATE_EXPIRE_GRACE < now);
    if (!expired.length) return config;
    let keptIntermediates = getIntermediateSources(config).filter(x => !expired.includes(x));
    let resolved = resolveIntermediateSources(config);
    let result = resolved;
    for (let keep of keptIntermediates) {
        result = injectIntermediateSource(result, {
            splitUrl: findSplitUrl(config, keep) || keep.url,
            intermediateUrl: keep.url,
            start: keep.validWindow[0],
            end: keep.validWindow[1],
        });
    }
    return result;
}

/** The url of the entry an intermediate was split out of - the neighbour it touches. */
export function findSplitUrl(config: RemoteConfig, intermediate: ObjectSource): string | undefined {
    let [start, end] = intermediate.validWindow;
    let neighbour = config.sources.find(x => isObjectSource(x) && !x.intermediate && (x.validWindow[1] === start || x.validWindow[0] === end)) as ObjectSource | undefined;
    return neighbour?.url;
}
