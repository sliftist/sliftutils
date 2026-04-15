import { runInfinitePoll } from "socket-function/src/batching";
import { timeInSecond } from "socket-function/src/misc";
import { startMeasure, logMeasureTable } from "socket-function/src/profiling/measure";

export function runAutoMeasure() {
    let measureObj = startMeasure();

    function logProfileMeasuresTimingsNow(force = false) {
        let profile = measureObj.finish();
        measureObj = startMeasure();
        logMeasureTable(profile, {
            name: `watchdog at ${new Date().toLocaleString()}`,
            // NOTE: Much higher min log times, now that we are combining logs.
            minTimeToLog: force ? 0 : 250,
            thresholdInTable: 0,
            setTitle: true
        });
        logMeasureTable(profile, {
            name: `watchdog at ${new Date().toLocaleString()}`,
            mergeDepth: 1,
            minTimeToLog: force ? 0 : 250,
        });
    }
    function logNow() {
        logProfileMeasuresTimingsNow(true);
    }
    (globalThis as any).logProfileMeasuresNow = logNow;
    (globalThis as any).logAll = logNow;
    (globalThis as any).logNow = logNow;

    (globalThis as any).logUnfiltered = function logUnfiltered(depth = 2) {
        let profile = measureObj.finish();
        measureObj = startMeasure();
        logMeasureTable(profile, {
            name: `all logs at ${new Date().toLocaleString()}`,
            mergeDepth: depth,
            minTimeToLog: 0,
            maxTableEntries: 10000000,
            thresholdInTable: 0
        });
    };
    runInfinitePoll(timeInSecond * 60, logProfileMeasuresTimingsNow);
}