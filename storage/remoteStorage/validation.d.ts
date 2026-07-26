export declare function assertValidName(value: string, kind: string): void;
/** A store's name (see CommonConfig.name), which also allows dots - a name is often a host or a version, and both read wrong without them. It is one path segment of the store's folder, so the two names that would mean a different folder entirely are rejected: everything else containing dots is just a name. */
export declare function assertValidSourceName(value: string): void;
export declare function assertValidPath(path: string): void;
/** Method decorator: validates the well-known fields of the method's single config-object argument - account/bucketName as names, path as a path - before the method runs. Fields the config doesn't have are skipped, so it applies to every API method uniformly. prefix is deliberately NOT validated: prefixes may be empty or end with "/", both invalid for paths. */
export declare function assertValidArgs(target: unknown, key: string, descriptor: PropertyDescriptor): void;
