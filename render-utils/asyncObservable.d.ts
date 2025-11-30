export declare function asyncCache<Args, T>(getValue: (args: Args) => Promise<T>): {
    (args: Args): T | undefined;
};
