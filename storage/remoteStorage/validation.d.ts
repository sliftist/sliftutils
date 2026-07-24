export declare function assertValidName(value: string, kind: string): void;
export declare function assertValidPath(path: string): void;
/** Method decorator: validates the well-known fields of the method's single config-object argument - account/bucketName as names, path as a path - before the method runs. Fields the config doesn't have are skipped, so it applies to every API method uniformly. prefix is deliberately NOT validated: prefixes may be empty or end with "/", both invalid for paths. */
export declare function assertValidArgs(target: unknown, key: string, descriptor: PropertyDescriptor): void;
