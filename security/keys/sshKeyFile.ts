import crypto from "crypto";

// OpenSSH keeps private keys in its own container rather than anything node can read, so the few
// bytes of it we need are handled here. Only unencrypted ed25519 keys are supported, which is what
// a key used by automation is.

const MAGIC = "openssh-key-v1\0";
const KEY_TYPE = "ssh-ed25519";
const NONE = "none";
const SEED_LENGTH = 32;
const PUBLIC_LENGTH = 32;
// The one block size that matters here, since nothing is encrypted.
const PADDING_BLOCK = 8;
const PEM_LINE_LENGTH = 70;
const PRIVATE_HEADER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const PRIVATE_FOOTER = "-----END OPENSSH PRIVATE KEY-----";
// The prefix that turns a bare 32 byte seed into a pkcs8 ed25519 key node will accept.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

class ByteReader {
    private offset = 0;
    constructor(private buffer: Buffer) { }

    readBytes(length: number) {
        let value = this.buffer.subarray(this.offset, this.offset + length);
        if (value.length !== length) {
            throw new Error(`Expected ${length} bytes at offset ${this.offset}, was ${value.length}`);
        }
        this.offset += length;
        return value;
    }

    readUInt32() {
        let value = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return value;
    }

    readString() {
        return this.readBytes(this.readUInt32());
    }
}

function writeString(value: Buffer | string) {
    let contents = Buffer.isBuffer(value) && value || Buffer.from(value, "utf8");
    let length = Buffer.alloc(4);
    length.writeUInt32BE(contents.length);
    return Buffer.concat([length, contents]);
}

function writeUInt32(value: number) {
    let bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
}

/** The public key of a seed, worked out by node rather than by reimplementing the curve. */
export function publicKeyFromSeed(seed: Buffer) {
    if (seed.length !== SEED_LENGTH) {
        throw new Error(`Expected a ${SEED_LENGTH} byte seed, was ${seed.length}`);
    }
    let privateKey = crypto.createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
        format: "der",
        type: "pkcs8",
    });
    // The spki wrapper is a fixed 12 byte header followed by the raw key.
    // The cast is because some @types/node versions don't accept a KeyObject here, even though the
    // runtime always has. Consumers compile us with their own @types/node, so this has to not fail.
    return crypto.createPublicKey(privateKey as any).export({ format: "der", type: "spki" }).subarray(12);
}

export function parseOpenSSHPrivateKey(contents: string) {
    let body = contents.split("\n").filter(line => line.trim() && !line.startsWith("-----")).join("");
    if (!contents.includes(PRIVATE_HEADER)) {
        throw new Error(`Expected an OpenSSH private key starting with ${PRIVATE_HEADER}`);
    }
    let reader = new ByteReader(Buffer.from(body, "base64"));
    if (reader.readBytes(MAGIC.length).toString() !== MAGIC) {
        throw new Error(`Expected the key to start with ${JSON.stringify(MAGIC)}`);
    }
    let cipherName = reader.readString().toString();
    let kdfName = reader.readString().toString();
    reader.readString();
    if (cipherName !== NONE || kdfName !== NONE) {
        throw new Error(
            `Expected an unencrypted key, was encrypted with ${cipherName}/${kdfName}.`
            + ` Remove the passphrase with "ssh-keygen -p" first.`
        );
    }
    let keyCount = reader.readUInt32();
    if (keyCount !== 1) {
        throw new Error(`Expected the key file to hold one key, held ${keyCount}`);
    }
    reader.readString();

    let privateSection = new ByteReader(reader.readString());
    let checkOne = privateSection.readUInt32();
    let checkTwo = privateSection.readUInt32();
    if (checkOne !== checkTwo) {
        throw new Error(`Expected the key's two check values to match, were ${checkOne} and ${checkTwo}`);
    }
    let keyType = privateSection.readString().toString();
    if (keyType !== KEY_TYPE) {
        throw new Error(`Expected an ${KEY_TYPE} key, was ${keyType}`);
    }
    privateSection.readString();
    // OpenSSH stores the seed and the public key together in the private field.
    let privateValue = privateSection.readString();
    if (privateValue.length !== SEED_LENGTH + PUBLIC_LENGTH) {
        throw new Error(`Expected a ${SEED_LENGTH + PUBLIC_LENGTH} byte private value, was ${privateValue.length}`);
    }
    return {
        seed: privateValue.subarray(0, SEED_LENGTH),
        publicKey: privateValue.subarray(SEED_LENGTH),
        comment: privateSection.readString().toString(),
    };
}

export function formatOpenSSHPrivateKey(config: { seed: Buffer; comment: string }) {
    let { seed, comment } = config;
    let publicKey = publicKeyFromSeed(seed);
    let publicBlob = Buffer.concat([writeString(KEY_TYPE), writeString(publicKey)]);

    // The check value only proves a passphrase decrypted correctly, and nothing here is encrypted.
    // Taking it from the seed keeps the same input producing the same file, so deriving a key twice
    // is something you can compare rather than something that looks different every time.
    let check = crypto.createHash("sha256").update(seed).digest().readUInt32BE(0);
    let privateSection = Buffer.concat([
        writeUInt32(check),
        writeUInt32(check),
        writeString(KEY_TYPE),
        writeString(publicKey),
        writeString(Buffer.concat([seed, publicKey])),
        writeString(comment),
    ]);
    let paddingLength = (PADDING_BLOCK - privateSection.length % PADDING_BLOCK) % PADDING_BLOCK;
    let padding = Buffer.from(Array.from({ length: paddingLength }, (unused, index) => index + 1));

    let contents = Buffer.concat([
        Buffer.from(MAGIC),
        writeString(NONE),
        writeString(NONE),
        writeString(""),
        writeUInt32(1),
        writeString(publicBlob),
        writeString(Buffer.concat([privateSection, padding])),
    ]);
    let encoded = contents.toString("base64").match(new RegExp(`.{1,${PEM_LINE_LENGTH}}`, "g")) || [];
    return `${PRIVATE_HEADER}\n${encoded.join("\n")}\n${PRIVATE_FOOTER}\n`;
}

/** The single line form, as it appears in authorized_keys and in a .pub file. */
export function formatPublicKeyLine(config: { publicKey: Buffer; comment: string }) {
    let { publicKey, comment } = config;
    let blob = Buffer.concat([writeString(KEY_TYPE), writeString(publicKey)]);
    return `${KEY_TYPE} ${blob.toString("base64")}${comment && ` ${comment}` || ""}\n`;
}
