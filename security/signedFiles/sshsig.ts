import crypto from "crypto";

// Verifies an SSHSIG signature (the format ssh-keygen -Y sign produces) in process, so nothing has
// to shell out to ssh-keygen to check one. The wire format is PROTOCOL.sshsig, and the actual
// check is one ed25519 verification.
//
// Both ed25519 and the hardware sk-ed25519 variant are handled, since signfiles signs with a
// hardware ed25519-sk key. The sk variant signs a little more than the message - the authenticator
// flags and counter go in too - but it is still ed25519 underneath.

const MAGIC = "SSHSIG";
// An ed25519 public key as a DER SPKI is this fixed 12 byte header followed by the 32 byte key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Reads the length prefixed fields SSH wire format is made of. */
class Reader {
    private offset = 0;
    constructor(private buffer: Buffer) { }
    u8() {
        return this.buffer.readUInt8(this.offset++);
    }
    u32() {
        let value = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return value;
    }
    string() {
        let length = this.u32();
        let value = this.buffer.subarray(this.offset, this.offset + length);
        this.offset += length;
        return value;
    }
    remaining() {
        return this.buffer.length - this.offset;
    }
}

/** One length prefixed field, the way SSH writes them. */
function sshString(bytes: Buffer) {
    let length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
}

function hash(algorithm: string, data: Buffer) {
    // SSHSIG names sha256 or sha512; node uses the same names.
    if (algorithm !== "sha256" && algorithm !== "sha512") {
        throw new Error(`Unsupported SSHSIG hash algorithm ${JSON.stringify(algorithm)}`);
    }
    return crypto.createHash(algorithm).update(data).digest();
}

function ed25519PublicKey(rawKey: Buffer) {
    if (rawKey.length !== 32) {
        throw new Error(`Expected a 32 byte ed25519 key, was ${rawKey.length}`);
    }
    return crypto.createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
        format: "der",
        type: "spki",
    });
}

/** Verifies an SSHSIG signature over a message, and that it was made for the given namespace.
    Returns the signing public key and its fingerprint, in the forms ssh-keygen reports them.
    Throws if it does not verify, or is not for this namespace. */
export function verifySSHSIG(config: { signature: string; message: Buffer; namespace: string }) {
    let { signature, message, namespace } = config;

    let body = signature.split("\n").filter(line => line && !line.startsWith("-----")).join("");
    let blob = Buffer.from(body, "base64");
    if (blob.subarray(0, MAGIC.length).toString() !== MAGIC) {
        throw new Error(`Expected an ${MAGIC} signature, started with ${JSON.stringify(blob.subarray(0, MAGIC.length).toString())}`);
    }

    let reader = new Reader(blob.subarray(MAGIC.length));
    let version = reader.u32();
    if (version !== 1) {
        throw new Error(`Expected SSHSIG version 1, was ${version}`);
    }
    let publicKeyBlob = reader.string();
    let signatureNamespace = reader.string().toString();
    reader.string(); // reserved
    let hashAlgorithm = reader.string().toString();
    let signatureBlob = reader.string();

    if (signatureNamespace !== namespace) {
        throw new Error(`Signature is for namespace ${JSON.stringify(signatureNamespace)}, expected ${JSON.stringify(namespace)}`);
    }

    let publicKeyReader = new Reader(publicKeyBlob);
    let keyType = publicKeyReader.string().toString();
    let rawKey = publicKeyReader.string();
    let application = publicKeyReader.remaining() ? publicKeyReader.string() : Buffer.alloc(0);

    let signatureReader = new Reader(signatureBlob);
    let signatureType = signatureReader.string().toString();
    let rawSignature = signatureReader.string();
    if (signatureType !== keyType) {
        throw new Error(`Signature type ${signatureType} does not match key type ${keyType}`);
    }

    // The bytes the signature is over: the magic, the namespace, the reserved field, the hash
    // algorithm, and the hash of the message. Never the message itself, so a huge file still signs
    // a fixed size blob.
    let signed = Buffer.concat([
        Buffer.from(MAGIC),
        sshString(Buffer.from(signatureNamespace)),
        sshString(Buffer.alloc(0)),
        sshString(Buffer.from(hashAlgorithm)),
        sshString(hash(hashAlgorithm, message)),
    ]);

    let toVerify: Buffer;
    if (keyType === "ssh-ed25519") {
        toVerify = signed;
    } else if (keyType === "sk-ssh-ed25519@openssh.com") {
        // A hardware key signs over what the authenticator saw, not the blob directly: the hash of
        // the application it is scoped to, the flags and counter it returned, and the hash of the
        // blob. Reconstructing that is the whole difference from a plain ed25519 signature.
        let flags = signatureReader.u8();
        let counter = signatureReader.u32();
        let counterBytes = Buffer.alloc(4);
        counterBytes.writeUInt32BE(counter);
        toVerify = Buffer.concat([
            hash("sha256", application),
            Buffer.from([flags]),
            counterBytes,
            hash("sha256", signed),
        ]);
    } else {
        throw new Error(`Unsupported SSHSIG key type ${JSON.stringify(keyType)}`);
    }

    if (!crypto.verify(null, toVerify, ed25519PublicKey(rawKey), rawSignature)) {
        throw new Error(`The SSHSIG signature does not verify`);
    }

    let fingerprint = "SHA256:" + crypto.createHash("sha256").update(publicKeyBlob).digest("base64").replace(/=+$/, "");
    return { publicKey: `${keyType} ${publicKeyBlob.toString("base64")}`, fingerprint };
}
