import https from "https";
import type { IncomingMessage, ServerResponse } from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { execFileSync } from "child_process";
import { getExternalIP } from "socket-function/src/networking";
import { forwardPort } from "socket-function/src/forwardPort";
import { runInfinitePollCallAtStart } from "socket-function/src/batching";
import { WebSocketServer, WebSocket } from "ws";
import { BulkDatabaseBase, bulkDatabase2Timing, noopReactiveDeps, BULK_ROOT_FOLDER } from "./BulkDatabase2/BulkDatabaseBase";
import { wrapHandle, NodeJSDirectoryHandleWrapper, DirectoryWrapper } from "./FileFolderAPI";

process.on("uncaughtException", err => {
    console.error(`[writeServer] uncaughtException (continuing):`, (err as Error).stack ?? err);
});
process.on("unhandledRejection", reason => {
    console.error(`[writeServer] unhandledRejection (continuing):`, (reason as Error)?.stack ?? reason);
});

// Remote file server for sliftutils getRemoteFileStorage / BulkDatabase2. Serves one folder on disk over
// self-signed HTTPS, authenticated with an auto-generated 6-word password (sent as
// `Authorization: Bearer <password>`). Run it with `yarn filehoster <folder>` (or the `filehoster` bin).
//
// SECURITY: the cert is self-signed, so a browser must accept it once (open the printed https URL and
// click through), and the Node client connects with cert verification disabled. The password is what
// authorizes access; keep it secret.

// Common, memorable words (frequency-ordered subset) for passphrase generation.
const WORDS: string[] = [
    "that", "with", "which", "this", "from", "have", "they", "were", "their", "there", "when", "them", "said", "been",
    "would", "will", "what", "more", "then", "into", "some", "could", "time", "very", "than", "your", "other", "upon",
    "about", "only", "little", "like", "these", "great", "after", "well", "made", "before", "such", "over", "should",
    "first", "good", "must", "much", "down", "where", "know", "most", "here", "come", "those", "never", "life", "long",
    "came", "being", "many", "through", "even", "himself", "back", "every", "shall", "again", "make", "without", "might",
    "while", "same", "under", "just", "still", "people", "place", "think", "house", "take", "last", "found", "away",
    "hand", "went", "thought", "also", "though", "three", "another", "eyes", "years", "work", "right", "once", "night",
    "young", "nothing", "against", "small", "head", "left", "part", "ever", "world", "each", "father", "give", "between",
    "face", "king", "things", "love", "because", "took", "always", "tell", "called", "water", "both", "side", "look",
    "having", "room", "mind", "half", "heart", "name", "home", "country", "whole", "however", "find", "among", "going",
    "thing", "lord", "looked", "seen", "mother", "general", "done", "seemed", "told", "whom", "days", "soon", "better",
    "letter", "woman", "heard", "asked", "course", "thus", "moment", "knew", "light", "enough", "white", "almost",
    "until", "quite", "hands", "words", "death", "large", "taken", "since", "gave", "given", "best", "state", "brought",
    "does", "whose", "door", "others", "power", "perhaps", "present", "next", "morning", "poor", "lady", "four", "high",
    "year", "turned", "less", "word", "full", "during", "rather", "want", "order", "near", "feet", "true", "miss",
    "matter", "began", "cannot", "used", "known", "felt", "above", "round", "thou", "voice", "till", "case", "nature",
    "indeed", "church", "kind", "certain", "fire", "often", "stood", "fact", "friend", "girl", "five", "land", "says",
    "john", "myself", "along", "point", "dear", "wife", "city", "within", "sent", "times", "keep", "passed", "form",
    "second", "body", "money", "believe", "hundred", "open", "several", "means", "child", "english", "herself", "sure",
    "looking", "women", "already", "black", "alone", "least", "gone", "held", "itself", "whether", "hope", "river",
    "ground", "either", "number", "chapter", "england", "leave", "rest", "town", "hear", "greek", "friends", "book",
    "hour", "short", "cried", "read", "behind", "became", "making", "family", "earth", "captain", "around", "dead",
    "reason", "call", "become", "lost", "line", "replied", "help", "coming", "speak", "manner", "french", "twenty",
    "spirit", "really", "early", "story", "hard", "close", "human", "public", "truth", "strong", "master", "care",
    "towards", "history", "kept", "later", "states", "dark", "able", "mean", "return", "brother", "person", "subject",
    "soul", "party", "arms", "thee", "seems", "common", "fell", "fine", "feel", "show", "table", "turn", "wish", "evening",
    "free", "cause", "south", "ready", "north", "across", "rose", "live", "account", "doubt", "company", "miles", "road",
    "bring", "london", "sense", "horse", "carried", "hold", "sight", "fear", "answer", "idea", "force", "need", "deep",
    "further", "nearly", "past", "army", "blood", "street", "court", "reached", "view", "school", "sort", "taking",
    "else", "chief", "hours", "beyond", "cold", "none", "longer", "strange", "fellow", "clear", "service", "natural",
    "suppose", "late", "talk", "front", "stand", "purpose", "seem", "neither", "ought", "west", "real", "except", "sound",
    "gold", "forward", "feeling", "added", "boys", "self", "peace", "happy", "living", "husband", "toward", "spoke",
    "fair", "france", "trees", "effect", "latter", "length", "change", "died", "green", "united", "fall", "pretty",
    "placed", "meet", "forth", "office", "comes", "pass", "written", "ship", "enemy", "saying", "tree", "foot", "blue",
    "note", "prince", "hair", "heaven", "wild", "play", "entered", "society", "laid", "wind", "doing", "paper", "opened",
    "bear", "third", "queen", "mine", "greater", "various", "faith", "wanted", "boat", "stone", "lived", "george",
    "window", "doctor", "action", "books", "tried", "letters", "makes", "minutes", "parts", "wood", "period", "duty",
    "york", "instead", "heavy", "persons", "battle", "field", "british", "object", "century", "island", "beauty",
    "christ", "sister", "glad", "below", "east", "opinion", "save", "places", "months", "food", "sweet", "trouble",
    "system", "born", "desire", "works", "mary", "chance", "william", "seven", "single", "hardly", "sleep", "mouth",
    "horses", "silence", "ancient", "broken", "hall", "send", "rich", "girls", "besides", "lips", "henry", "figure",
    "slowly", "hill", "wall", "future", "lines", "follow", "german", "march", "filled", "brown", "deal", "eight",
    "covered", "smile", "former", "week", "drew", "easy", "paris", "camp", "stay", "cross", "seeing", "result", "started",
    "caught", "houses", "appear", "wrote", "giving", "simple", "arrived", "formed", "bright", "wide", "uncle", "piece",
    "walked", "knows", "carry", "middle", "village", "holy", "merely", "getting", "raised", "afraid", "struck",
    "charles", "board", "visit", "royal", "spring", "dinner", "evil", "outside", "wrong", "summer", "moved", "danger",
    "mark", "fresh", "plain", "thirty", "scene", "quickly", "wonder", "jack", "indian", "walk", "learned", "class",
    "secret", "wait", "command", "easily", "garden", "loved", "married", "fight", "leaving", "music", "usual", "cases",
    "winter", "respect", "value", "quiet", "please", "stopped", "write", "laughed", "america", "chair", "paid", "duke",
    "leaves", "lower", "colonel", "perfect", "james", "worth", "author", "finally", "youth", "regard", "glass",
    "picture", "built", "modern", "success", "race", "showed", "tears", "unless", "mere", "lives", "grew", "charge",
    "beside", "remain", "waiting", "study", "hath", "shot", "unto", "tone", "iron", "watch", "grace", "flowers", "killed",
    "allowed", "news", "step", "proper", "sitting", "floor", "justice", "noble", "goes", "walls", "laws", "meant",
    "bound", "forms", "fifty", "drawn", "private", "fast", "indians", "judge", "meeting", "usually", "sudden", "gives",
    "reach", "bank", "attempt", "shore", "stop", "plan", "silent", "special", "spot", "officer", "silver", "passing",
    "broke", "lake", "soft", "journey", "beneath", "shown", "turning", "members", "enter", "lead", "trade", "names",
    "escape", "troops", "bill", "corner", "rule", "ladies", "species", "rock", "similar", "running", "rate", "cast",
    "nation", "post", "likely", "simply", "orders", "dress", "fish", "minute", "birds", "europe", "passage", "surface",
    "snow", "attack", "higher", "rise", "grand", "reply", "honour", "notice", "speech", "trying", "game", "writing",
    "closed", "rome", "example", "aunt", "learn", "morrow", "offered", "peter", "equal", "space", "page", "wished",
    "changed", "animal", "social", "twelve", "appears", "receive", "valley", "degree", "train", "steps", "fixed",
    "count", "forest", "matters", "foreign", "native", "broad", "moral", "animals", "safe", "roman", "break", "pale",
    "memory", "warm", "trust", "yellow", "sides", "main", "bird", "reading", "coast", "pain", "grave", "forget", "move",
    "fortune", "madame", "proved", "forty", "lying", "quick", "wise", "jesus", "working", "surely", "looks", "seat",
    "divine", "touch", "loss", "paul", "heads", "spent", "ordered", "report", "caused", "thomas", "ones", "drawing",
    "talking", "breath", "meaning", "month", "union", "pleased", "powers", "emperor", "laugh", "affairs", "narrow",
    "square", "science", "begin", "promise", "takes", "conduct", "serious", "thank", "curious", "pieces", "health",
    "exactly", "ways", "upper", "decided", "nine", "stream", "wine", "engaged", "points", "amount", "named", "song",
    "worse", "size", "castle", "crown", "mass", "liberty", "stage", "guard", "servant", "greatly", "price", "weeks",
    "neck", "ears", "drink", "crowd", "thick", "fallen", "hills", "spoken", "golden", "capital", "sign", "spite", "terms",
    "sake", "council", "threw", "ships", "portion", "support", "clothes", "effort", "fully", "holding", "majesty",
    "glory", "pure", "facts", "sword", "sorry", "fate", "bread", "prove", "station", "sharp", "dream", "vain", "major",
    "smiled", "instant", "spread", "serve", "sick", "june", "ideas", "thrown", "start", "weather", "gray", "courage",
    "anxious", "woods", "path", "rising", "grass", "moon", "gate", "forced", "fancy", "bottom", "expect", "remains",
    "shook", "bishop", "watched", "settled", "events", "rain", "quarter", "heat", "palace", "glance", "kingdom",
    "papers", "aside", "worthy", "taste", "pride", "july", "opening", "daily", "leading", "wounded", "famous", "offer",
    "group", "distant", "weight", "highest", "vast", "popular", "passion", "knowing", "allow", "sought", "lies",
    "marked", "series", "growing", "measure", "hearts", "robert", "obliged", "western", "hence", "style", "dropped",
    "nations", "grown", "honor", "edge", "pray", "tall", "frank", "poet", "streets", "season", "pointed", "mighty",
    "temple", "extent", "thin", "blow", "freedom", "entire", "keeping", "prevent", "shut", "storm", "lose", "college",
    "cost", "marry", "spirits", "worked", "colour", "ring", "listen", "fruit", "waters", "fashion", "share", "hung",
    "proud", "fingers", "method", "served", "grow", "fort", "draw", "dollars", "quietly", "yours", "vessel", "direct",
    "refused", "bridge", "gods", "inside", "title", "advance", "priest", "becomes", "dick", "double", "seek", "guess",
    "spanish", "larger", "ball", "finding", "edward", "removed", "brave", "tired", "agreed", "sacred", "sons", "guns",
    "played", "richard", "devil", "pounds", "honest", "false", "cloth", "soldier", "tongue", "smith", "wealth", "failed",
    "height", "faces", "equally", "legs", "pocket", "twice", "volume", "prayer", "county", "notes", "louis", "unknown",
    "delight", "rights", "nice", "taught", "coat", "dare", "slight", "rocks", "enemies", "control", "forces", "germany",
    "kill", "process", "david", "rapidly", "comfort", "islands", "centre", "salt", "april", "windows", "noticed",
    "truly", "color", "fields", "date", "august", "desired", "breast", "skin", "gentle", "smoke", "search", "joined",
    "nobody", "results", "needed", "weak", "type", "stones", "follows", "theory", "shape", "waited", "telling", "relief",
    "bearing", "bent", "mile", "dressed", "birth", "spain", "female", "clearly", "moving", "drive", "crossed", "member",
    "saved", "teeth", "flesh", "cover", "shows", "farther", "stands", "figures", "numbers", "bodies", "supply", "motion",
    "grey", "bell", "alive", "seized", "shadow", "produce", "touched", "driven", "talked", "empire", "sunday", "pair",
    "fourth", "slave", "regular", "dozen", "beat", "cousin", "sand", "soil", "rough", "claim", "angry", "pity", "walking",
    "acts", "pope", "rooms", "task", "stock", "tender", "throw", "reader", "india", "hotel", "fifteen", "arrival",
    "plate", "stars", "willing", "stories", "saint", "amongst", "virtue", "chamber", "civil", "yards", "habit", "writer",
    "putting", "origin", "italy", "hearing", "genius", "milk", "busy", "fool", "burning", "duties", "brain", "slow",
    "belief", "bore", "mention", "grant", "library", "inches", "press", "calm", "total", "ride", "lands", "labor",
    "parties", "clean", "catch", "treated", "rode", "whilst", "level", "efforts", "minds", "welcome", "wisdom", "supper",
    "final", "mercy", "aware", "lovely", "empty", "wants", "midst", "central", "rank", "proof", "burst", "term", "farm",
    "applied", "loud", "nearer", "harry", "closely", "kings", "explain", "deck", "noise", "hurt", "advice", "absence",
    "circle", "objects", "secure", "plants", "parents", "falling", "base", "fellows", "sorrow", "flat", "flower",
    "calling", "imagine", "range", "sold", "favour", "happen", "showing", "earl", "hole", "careful", "dust", "prison",
    "useful", "accept", "firm", "sing", "port", "seated", "custom", "wore", "doors", "lifted", "edition", "tale",
    "affair", "policy", "roof", "express", "ahead", "worship", "partly", "address", "highly", "victory", "ocean",
    "begun", "buried", "content", "smiling", "liked", "active", "quality", "philip", "current", "divided", "growth",
    "huge", "moments", "article", "speed", "poetry", "machine", "join", "nose", "unable", "ceased", "gained", "worn",
    "eastern", "safety", "ages", "vessels", "hopes", "corn", "slaves", "drop", "plant", "evident", "local", "police",
    "october", "obtain", "italian", "deeply", "dying", "wholly", "dogs", "playing", "plenty", "apart", "suffer", "maid",
    "record", "fairly", "kindly", "terror", "drove", "ends", "sugar", "capable", "irish", "message", "chosen", "flight",
    "reasons", "couple", "meat", "printed", "blind", "energy", "bitter", "baby", "mistake", "tower", "ireland", "trial",
    "wear", "brief", "market", "band", "causes", "clouds", "goods", "admit", "cities", "earlier", "tells", "stated",
    "pressed", "crime", "fought", "guide", "hoped", "list", "banks", "knight", "fleet", "pulled", "tail", "patient",
    "mental", "boats", "kinds", "stairs", "star", "cattle", "rare", "wings", "disease", "section", "actual", "bare",
    "extreme", "cruel", "worst", "escaped", "dance", "strike", "views", "eggs", "needs", "store", "choice", "fond",
    "adopted", "suit", "singing", "fail", "souls", "thanks", "hidden", "shame", "faint", "shop", "older", "joseph",
    "knees", "gently", "blessed", "yard", "cent", "grief", "male", "sooner", "january", "excited", "region", "praise",
    "throne", "classes", "effects", "demand", "gain", "fault", "labour", "variety", "loose", "cook", "devoted", "ended",
    "changes", "witness", "bought", "lover", "visited", "club", "sheep", "cloud", "enjoy", "asleep", "cool", "dull",
    "painted", "arose", "armed", "dignity", "chiefly", "voices", "sail", "event", "signs", "hero", "schools", "branch",
    "hurried", "arthur", "kitchen", "stick", "coffee", "thinks", "eager", "natives", "flying", "boston", "eternal",
    "source", "fill", "anger", "vision", "murder", "viii", "park", "avoid", "awful", "raise", "desert", "plans", "pardon",
    "assured", "wound", "finger", "bible", "rear", "details", "cabin", "whence", "reign", "weary", "slavery", "visible",
    "shouted", "seldom", "skill", "hast", "throat", "reality", "leader", "egypt", "credit", "smaller", "severe", "calls",
    "younger", "shell", "sprang", "anybody", "handed", "despair", "asking", "inch", "mystery", "manners", "knife",
    "design", "sounds", "wishes", "stepped", "towns", "sixty", "immense", "china", "favor", "latin", "hate", "setting",
    "excuse", "chinese", "behold", "rushed", "choose", "ease", "lights", "paused", "mission", "voyage", "gift", "bold",
    "meal", "britain", "smooth", "mounted", "utterly", "lest", "helped", "picked", "falls", "pipe", "bones", "earnest",
    "granted", "swept", "anxiety", "teach", "waves", "softly", "savage", "hunting", "defence", "rapid", "artist",
    "recent", "supreme", "russian", "created", "habits", "exist", "guilty", "pages", "crew", "hell", "remark", "request",
    "harm", "solemn", "observe", "trail", "copy", "violent", "dreams", "proceed", "luck", "steel", "sell", "temper",
    "appeal", "hide", "fled", "belong", "triumph", "abroad", "waste", "consent", "writers", "possess", "jews", "require",
    "priests", "railway", "founded", "pushed", "host", "solid", "maybe", "degrees", "cheeks", "mount", "ruin", "owing",
    "fierce", "reduced", "mankind", "text", "swift", "riding", "silk", "shade", "career", "wicked", "afford", "alas",
    "rules", "treaty", "correct", "spend", "foolish", "methods", "remarks", "horror", "shining", "enjoyed", "tribes",
    "lack", "frame", "gets", "eagerly", "russia", "alike", "somehow", "nodded", "problem", "fever", "sees", "stern",
    "dawn", "forgive", "flag", "managed", "fame", "travel", "estate", "cotton", "hurry", "agree", "feared", "kiss",
    "million", "martin", "mixed", "risk", "butter", "jane", "assumed", "pause", "benefit", "unhappy", "lighted",
    "scheme", "slept", "plainly", "forgot", "delay", "merry", "rush", "wooden", "secured", "poem", "rolled", "angel",
    "guests", "farmer", "humble", "glanced", "shortly", "rope", "image", "lately", "africa", "fired", "retired", "bull",
    "steam", "keen", "loving", "borne", "readily", "beloved", "average", "teacher", "attend", "flame", "area", "burned",
    "thrust", "negro", "nurse", "spare", "fifth", "thence", "roads", "refuse", "tent", "kissed", "gates", "gaze", "fatal",
    "israel", "verse", "scenes", "confess", "uttered", "build", "acted", "hanging", "reward", "issue", "utmost",
    "fathers", "noted", "widow", "related", "urged", "mode", "failure", "nervous", "render", "masters", "tribe",
    "colored", "turns", "alarm", "rivers", "using", "eleven", "rage", "hers", "lamp", "retreat", "amid", "gospel",
    "exposed", "johnson", "marks", "tide", "emotion", "destroy", "inner", "sisters", "lion", "helen", "tied", "grounds",
    "acid", "wheel", "issued", "invited", "gazed", "senate", "finds", "seed", "regret", "clay", "chain", "crowded",
    "bosom", "limited", "steady", "chap", "anne", "francis", "cavalry", "freely", "charm", "faced", "ideal", "useless",
    "warning", "shelter", "vote", "xpage", "cottage", "beast", "outer", "folks", "misery", "anyone", "expense", "firmly",
    "eating", "lonely", "owner", "trace", "coal", "hastily", "elder", "utter", "begins", "chapel", "nights", "dared",
    "signal", "stared", "track", "lords", "speaks", "bottle", "blame", "claims", "shoes", "sigh", "ghost", "folk",
    "dutch", "flung", "flew", "cheek", "staff", "walter", "clever", "acting", "hungry", "poems", "cutting", "forever",
    "exact", "haste", "dancing", "trip", "lincoln", "pull", "vice", "slipped", "thine", "loves", "permit", "mill",
    "engine", "hollow", "seeking", "bowed", "largely", "charged", "painful", "madam", "roll", "leaf", "prayers",
    "element", "agent", "cries", "songs", "theatre", "creek", "match", "ashamed", "runs", "aspect", "canada", "treat",
    "legal", "arts", "corps", "noon", "nearest", "scale", "hunt", "shadows", "winds", "landed", "beings", "tiny",
    "gardens", "bless", "clerk", "doth", "derived", "hang", "heavens", "cape", "ours", "brow", "test", "senses",
    "opposed", "error", "driving", "nest", "headed", "groups", "princes", "feast", "admiral", "poured", "brings",
    "pursued", "germans", "bears", "lesson", "journal", "unusual", "marched", "wing", "remove", "studied", "passes",
    "actions", "burden", "colony", "scott", "bride", "yield", "crying", "forming", "rifle", "powder", "rested", "shake",
    "guest", "begged", "occur", "altar", "sorts", "beaten", "wave", "papa", "sang", "depth", "aloud", "contact",
    "intense", "marble", "poverty", "detail", "writes", "root", "metal", "jean", "existed", "ability", "purple",
    "counsel", "lane", "wives", "sending", "heavily", "leaders", "queer", "tales", "sins", "mexico", "protect", "clock",
    "stuff", "jones", "pine", "records", "cave", "baron", "medical", "pick", "stayed", "magic", "seventy", "pour",
    "saddle", "sank", "dread", "deny", "wire", "rude", "holds", "strain", "autumn", "shed", "shoot", "settle", "basis",
    "readers", "route", "beach", "safely", "oxford", "notion", "thunder", "sale", "saints", "pound", "shock", "elected",
    "signed", "whereas", "maiden", "courts", "rarely", "wolf", "mamma", "billy", "student", "charity", "impulse",
    "tones", "mortal", "raising", "wedding", "belongs", "chest", "sharply", "sounded", "poets", "lawyer", "hugh",
    "plays", "awake", "landing", "debt", "alice", "venture", "idle", "uniform", "contain", "tobacco", "boots", "fears",
    "leaned", "studies", "customs", "prize", "stir", "obey", "oath", "badly", "pursuit", "resting",
];

export function generatePassword(wordCount: number): string {
    const words: string[] = [];
    for (let i = 0; i < wordCount; i++) words.push(WORDS[crypto.randomInt(WORDS.length)]);
    return words.join(" ");
}

// The password is always a list of words, so we compare case-insensitively and ignore any non-letter
// characters. That makes it forgiving of voice dictation and mobile autocorrect (spacing, capitals,
// stray punctuation) without meaningfully weakening a 6-word passphrase.
function normalizePassword(p: string): string {
    return String(p || "").toLowerCase().replace(/[^a-z]/g, "");
}

// The password is generated once and saved (next to the cert, outside the served folder), then reused
// across restarts — so connected clients keep working after the server bounces, instead of getting a
// new password every time. Override with the PASSWORD env var.
function getOrCreatePassword(): string {
    const dir = path.join(os.homedir(), ".sliftutils-remote");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "password.txt");
    try {
        const existing = fs.readFileSync(file, "utf8").trim();
        if (existing) return existing;
    } catch { /* not created yet */ }
    const pw = generatePassword(6);
    fs.writeFileSync(file, pw + "\n", { mode: 0o600 });
    return pw;
}

// Generate (once) and cache a self-signed key + cert via openssl, outside the served folder so its
// private key is never reachable through the API.
function getCert(): { key: Buffer; cert: Buffer } {
    const dir = path.join(os.homedir(), ".sliftutils-remote");
    fs.mkdirSync(dir, { recursive: true });
    const keyPath = path.join(dir, "key.pem");
    const certPath = path.join(dir, "cert.pem");
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        try {
            execFileSync("openssl", [
                "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-keyout", keyPath, "-out", certPath, "-days", "3650",
                "-subj", "/CN=sliftutils-remote",
                "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
            ], { stdio: "ignore" });
        } catch (e) {
            throw new Error("Failed to generate a self-signed certificate with openssl (is openssl installed?): " + (e as Error).message);
        }
    }
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

function timingSafeEqualStr(a: string, b: string): boolean {
    const ab = Buffer.from(a || "", "utf8");
    const bb = Buffer.from(b || "", "utf8");
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

// Resolve a client-supplied relative path against the root, refusing anything that escapes it.
function safeResolve(root: string, rel: string | null): string | undefined {
    if (rel == null) rel = "";
    if (rel.indexOf("\0") >= 0) return undefined;
    const full = path.resolve(root, "." + path.sep + rel.replace(/\\/g, "/"));
    if (full !== root && !full.startsWith(root + path.sep)) return undefined;
    return full;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", c => chunks.push(c as Buffer));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function formatBytes(n: number): string {
    if (n < 1024) return n + "B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + "GB";
}

// Parse a single-range HTTP Range header ("bytes=start-end", "bytes=start-", "bytes=-suffix") into an
// INCLUSIVE [start, end]. Returns "unsatisfiable" for a range past the file, or undefined for no/garbled
// range (caller then serves the whole file). Only single ranges are supported (what media players use).
function parseRange(header: string, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m) return undefined;
    const sRaw = m[1], eRaw = m[2];
    if (sRaw === "" && eRaw === "") return undefined;
    let start: number, end: number;
    if (sRaw === "") {
        const suffix = parseInt(eRaw, 10);
        if (!suffix) return "unsatisfiable";
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = parseInt(sRaw, 10);
        end = eRaw === "" ? size - 1 : parseInt(eRaw, 10);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "unsatisfiable";
    return { start, end: Math.min(end, size - 1) };
}

const MEDIA_TYPES: Record<string, string> = {
    mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime",
    avi: "video/x-msvideo", ogv: "video/ogg", ts: "video/mp2t",
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/opus",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
    pdf: "application/pdf", txt: "text/plain; charset=utf-8", json: "application/json",
};
function mediaContentType(filePath: string): string {
    const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
    return MEDIA_TYPES[ext] || "application/octet-stream";
}

// Public (no-auth) landing page. The browser can't trust a self-signed cert from a background fetch, so
// the user opens this URL once, accepts the browser's security warning, and the cert becomes trusted for
// the origin — then the app's fetches work. This page is what they see after accepting.
const CERT_LANDING_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sliftutils file server</title></head><body style="font-family:system-ui,sans-serif;max-width:34em;margin:3em auto;padding:0 1em;line-height:1.5;color:#222"><h2>&#10003; Certificate accepted</h2><p>This is your <b>sliftutils file server</b>. Your browser now trusts its self-signed certificate for this address.</p><p>Return to the app and click <b>Retry</b> (or <b>Connect</b>) to finish connecting with your password.</p><p style="color:#888;font-size:.9em">You can close this tab.</p></body></html>`;

export type RemoteFileServerOptions = {
    root: string;
    port?: number;
    host?: string;
    password?: string;
    // When true, log batched per-(client, file) access totals every 5s. The CLI turns this on; the
    // library (tests) leaves it off.
    logAccess?: boolean;
};
export type RemoteFileServerHandle = { port: number; password: string; url: string; close: () => Promise<void> };

export function startRemoteFileServer(options: RemoteFileServerOptions): Promise<RemoteFileServerHandle> {
    const root = path.resolve(options.root);
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    const port = options.port ?? 8787;
    const host = options.host || "0.0.0.0";
    const password = options.password || getOrCreatePassword();
    const normPassword = normalizePassword(password);
    const { key, cert } = getCert();

    // Batched access log: aggregate per (ip, op, file) so hammering one file logs once per 5s with the
    // total request count and bytes, instead of a line per request.
    type Acc = { ip: string; op: string; path: string; count: number; bytes: number };
    const accessLog = new Map<string, Acc>();
    let flushTimer: ReturnType<typeof setInterval> | undefined;
    const recordAccess = (ip: string, op: string, p: string, bytes: number) => {
        if (!options.logAccess) return;
        const k = ip + "|" + op + "|" + p;
        let e = accessLog.get(k);
        if (!e) { e = { ip, op, path: p, count: 0, bytes: 0 }; accessLog.set(k, e); }
        e.count++;
        e.bytes += bytes;
    };
    if (options.logAccess) {
        flushTimer = setInterval(() => {
            if (!accessLog.size) return;
            const rows = [...accessLog.values()].sort((a, b) => b.bytes - a.bytes);
            accessLog.clear();
            // Fixed-width columns first so lines align, then the variable-length path last. count is the
            // number of requests folded into this row (R = requests, not a multiplier).
            const time = new Date().toTimeString().slice(0, 8);
            for (const e of rows) {
                const size = formatBytes(e.bytes).padStart(9);
                const reqs = (e.count + "R").padStart(6);
                const op = `[${e.op.padEnd(5)}]`;
                const ip = e.ip.padEnd(15);
                console.log(`  ${time}  ${size}  ${reqs}  ${op}  ${ip}  ${e.path}`);
            }
        }, 5000);
        flushTimer.unref?.();
    }
    const clientIp = (req: IncomingMessage) => (req.socket.remoteAddress || "?").replace(/^::ffff:/, "");

    const server = https.createServer({ key, cert }, async (req: IncomingMessage, res: ServerResponse) => {
        const origin = (req.headers["origin"] as string) || "*";
        const cors: Record<string, string> = {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "authorization, content-type, range",
            "Access-Control-Expose-Headers": "content-range, accept-ranges, content-length",
            "Access-Control-Max-Age": "86400",
            "Vary": "Origin",
        };
        const send = (status: number, headers: Record<string, string>, body?: Buffer | string) => {
            res.writeHead(status, Object.assign({}, cors, headers));
            res.end(body);
        };
        const sendJson = (status: number, obj: unknown) => send(status, { "Content-Type": "application/json" }, JSON.stringify(obj));

        try {
            if (req.method === "OPTIONS") return send(204, {});

            const url = new URL(req.url || "/", "https://localhost");
            const op = url.pathname;

            // Public landing page so the user can open the URL once to accept the self-signed cert.
            if (req.method === "GET" && (op === "/" || op === "/index.html")) {
                return send(200, { "Content-Type": "text/html; charset=utf-8" }, CERT_LANDING_HTML);
            }

            const auth = (req.headers["authorization"] as string) || "";
            // Bearer header for API clients; ?token= query for media URLs (a <video> element can't set headers).
            const token = (auth.startsWith("Bearer ") ? auth.slice(7) : "") || url.searchParams.get("token") || "";
            if (!timingSafeEqualStr(normalizePassword(token), normPassword)) return sendJson(401, { error: "unauthorized" });

            const relPath = url.searchParams.get("path") || "";
            const full = safeResolve(root, relPath);
            if (full === undefined) return sendJson(403, { error: "path escapes root" });

            // One listing returns every entry with its type, so a directory read is a single round trip.
            if (req.method === "GET" && op === "/list") {
                let entries: fs.Dirent[];
                try { entries = fs.readdirSync(full, { withFileTypes: true }); }
                catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? sendJson(200, []) : sendJson(500, { error: (e as Error).message }); }
                return sendJson(200, entries.filter(d => d.isFile() || d.isDirectory()).map(d => ({ name: d.name, dir: d.isDirectory() })));
            }
            if (req.method === "GET" && op === "/info") {
                let st: fs.Stats;
                try { st = fs.statSync(full); } catch { return sendJson(404, { error: "not found" }); }
                return sendJson(200, { size: st.size, lastModified: st.mtimeMs, dir: st.isDirectory() });
            }
            if (req.method === "GET" && op === "/read") {
                let st: fs.Stats;
                try { st = fs.statSync(full); } catch { return sendJson(404, { error: "not found" }); }
                let start = parseInt(url.searchParams.get("start") || "0", 10);
                let end = url.searchParams.get("end") != null ? parseInt(url.searchParams.get("end") as string, 10) : st.size;
                start = Math.min(Math.max(start, 0), st.size);
                end = Math.min(Math.max(end, start), st.size);
                recordAccess(clientIp(req), "read", relPath, end - start);
                res.writeHead(200, Object.assign({}, cors, { "Content-Type": "application/octet-stream", "Content-Length": String(end - start) }));
                if (end === start) return res.end();
                fs.createReadStream(full, { start, end: end - 1 }).on("error", () => res.end()).pipe(res);
                return;
            }
            // Range-capable media endpoint for <video>/<img>/fetch: honors the Range header (206 +
            // Content-Range + Accept-Ranges) so seeking works. Auth came from the ?token= query above.
            if ((req.method === "GET" || req.method === "HEAD") && op === "/media") {
                let st: fs.Stats;
                try { st = fs.statSync(full); } catch { return sendJson(404, { error: "not found" }); }
                if (st.isDirectory()) return sendJson(400, { error: "is a directory" });
                const rangeHeader = req.headers["range"] as string | undefined;
                const range = rangeHeader ? parseRange(rangeHeader, st.size) : undefined;
                if (range === "unsatisfiable") {
                    res.writeHead(416, Object.assign({}, cors, { "Content-Range": `bytes */${st.size}`, "Accept-Ranges": "bytes" }));
                    return res.end();
                }
                const start = range ? range.start : 0;
                const end = range ? range.end : st.size - 1; // inclusive
                const length = st.size === 0 ? 0 : end - start + 1;
                const headers: Record<string, string> = Object.assign({}, cors, {
                    "Content-Type": mediaContentType(full),
                    "Accept-Ranges": "bytes",
                    "Content-Length": String(length),
                });
                if (range) headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
                res.writeHead(range ? 206 : 200, headers);
                if (req.method === "HEAD" || length === 0) return res.end();
                recordAccess(clientIp(req), "read", relPath, length);
                fs.createReadStream(full, { start, end }).on("error", () => res.end()).pipe(res);
                return;
            }
            if ((req.method === "PUT" || req.method === "POST") && (op === "/append" || op === "/set")) {
                const body = await readBody(req);
                fs.mkdirSync(path.dirname(full), { recursive: true });
                if (op === "/append") fs.appendFileSync(full, body);
                else fs.writeFileSync(full, body);
                recordAccess(clientIp(req), "write", relPath, body.length);
                return sendJson(200, { ok: true });
            }
            // Removes a file or a directory (recursively); missing is fine.
            if (req.method === "DELETE" && op === "/remove") {
                try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) { return sendJson(500, { error: (e as Error).message }); }
                return sendJson(200, { ok: true });
            }
            return sendJson(404, { error: "unknown endpoint" });
        } catch (e) {
            try { sendJson(500, { error: String((e as Error)?.message || e) }); } catch { /* response already sent */ }
        }
    });

    // WebSocket transport: same operations as the HTTP handler, but binary-framed and multiplexed over one
    // socket so large concurrent reads don't pay per-request HTTP overhead. Frame: [u32 headerLen LE][header
    // JSON][body bytes]. Request header {id, op, path, start?, end?, password?}; response {id, status, error?}.
    const EMPTY = Buffer.alloc(0);
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
        const ip = clientIp(req);
        let authed = false;
        ws.on("message", (data: Buffer) => {
            let id = 0;
            const reply = (status: number, extra: object, body?: Buffer) => {
                const h = Buffer.from(JSON.stringify(Object.assign({ id, status }, extra)), "utf8");
                const len = Buffer.alloc(4);
                len.writeUInt32LE(h.length, 0);
                ws.send(Buffer.concat([len, h, body || EMPTY]));
            };
            void (async () => {
                // TODO: Fix this code. It's some of the worst code I've ever seen. All the try-catches are bad. There should just be a single try-catch. The comparisons are bad. They're pretending like null can exist in places when it can't. We're using the any type for no reason.
                let header: any;
                let body: Buffer;
                try {
                    const headerLen = data.readUInt32LE(0);
                    header = JSON.parse(data.subarray(4, 4 + headerLen).toString("utf8"));
                    body = data.subarray(4 + headerLen);
                } catch { return; }
                id = header.id || 0;
                try {
                    if (header.op === "auth") {
                        authed = timingSafeEqualStr(normalizePassword(header.password || ""), normPassword);
                        return reply(authed ? 200 : 401, {});
                    }
                    if (!authed) return reply(401, { error: "unauthorized" });
                    const rel = String(header.path || "");
                    const full = safeResolve(root, rel);
                    if (full === undefined) return reply(403, { error: "path escapes root" });
                    if (header.op === "info") {
                        let st: fs.Stats;
                        try { st = fs.statSync(full); } catch { return reply(404, {}); }
                        return reply(200, {}, Buffer.from(JSON.stringify({ size: st.size, lastModified: st.mtimeMs, dir: st.isDirectory() })));
                    }
                    if (header.op === "list") {
                        let entries: fs.Dirent[];
                        try { entries = fs.readdirSync(full, { withFileTypes: true }); }
                        catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? reply(200, {}, Buffer.from("[]")) : reply(500, { error: (e as Error).message }); }
                        return reply(200, {}, Buffer.from(JSON.stringify(entries.filter(d => d.isFile() || d.isDirectory()).map(d => ({ name: d.name, dir: d.isDirectory() })))));
                    }
                    if (header.op === "read") {
                        let st: fs.Stats;
                        try { st = fs.statSync(full); } catch { return reply(404, {}); }
                        const start = Math.min(Math.max(Number(header.start) || 0, 0), st.size);
                        const end = header.end != null ? Math.min(Math.max(Number(header.end), start), st.size) : st.size;
                        recordAccess(ip, "read", rel, end - start);
                        if (end === start) return reply(200, {}, EMPTY);
                        const fh = await fs.promises.open(full, "r");
                        try {
                            const buf = Buffer.allocUnsafe(end - start);
                            const { bytesRead } = await fh.read(buf, 0, end - start, start);
                            reply(200, {}, bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
                        } finally { await fh.close(); }
                        return;
                    }
                    if (header.op === "append" || header.op === "set") {
                        fs.mkdirSync(path.dirname(full), { recursive: true });
                        if (header.op === "append") fs.appendFileSync(full, body);
                        else fs.writeFileSync(full, body);
                        recordAccess(ip, "write", rel, body.length);
                        return reply(200, {});
                    }
                    if (header.op === "remove") {
                        try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) { return reply(500, { error: (e as Error).message }); }
                        return reply(200, {});
                    }
                    return reply(404, { error: "unknown op" });
                } catch (e) {
                    try { reply(500, { error: String((e as Error)?.message || e) }); } catch { /* socket gone */ }
                }
            })();
        });
    });

    return new Promise<RemoteFileServerHandle>((resolve, reject) => {
        server.on("error", reject);
        server.listen(port, host, () => {
            const addr = server.address();
            const actualPort = typeof addr === "object" && addr ? addr.port : port;
            resolve({
                port: actualPort,
                password,
                url: `https://localhost:${actualPort}`,
                close: () => new Promise<void>(r => { if (flushTimer) clearInterval(flushTimer); for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => r()); }),
            });
        });
    });
}

// ── server-side compaction (--autocompact) ──
// Remote clients (e.g. a TV) skip compaction by default — it's expensive to read/rewrite whole files over
// the network. So the host can do it locally instead: load each bulk database's index and run one merge
// pass, on startup and every 3 hours. Far more efficient (local disk, no network), and the data still gets
// compacted eventually.
const AUTOCOMPACT_INTERVAL_MS = 3 * 60 * 60 * 1000;
// One reused compactor instance per collection (keyed by baseDir\0name), so we don't leak the per-instance
// timers/caches by recreating instances each loop.
const compactors = new Map<string, BulkDatabaseBase<{ key: string }>>();
function getCompactor(baseDir: string, name: string): BulkDatabaseBase<{ key: string }> {
    const key = baseDir + "\0" + name;
    let db = compactors.get(key);
    if (!db) {
        // BulkDatabaseBase asks its factory for `bulkDatabases2/<name>`, so root the factory at baseDir.
        const factory = async (p: string) => {
            let base: DirectoryWrapper = new NodeJSDirectoryHandleWrapper(baseDir);
            for (const part of p.split("/")) { if (part) base = await base.getDirectoryHandle(part, { create: true }); }
            return wrapHandle(base);
        };
        db = new BulkDatabaseBase<{ key: string }>(name, noopReactiveDeps, factory);
        compactors.set(key, db);
    }
    return db;
}

// One full pass: rescan the disk for collections (new ones may have appeared) and run a merge on each,
// strictly one after another (never in parallel).
export async function autocompactBulkDatabases(root: string): Promise<void> {
    // Collections live under <baseDir>/bulkDatabases2/<name>/. The app may nest its data under a "data"
    // subfolder (see getFileStorageNested2's heuristic), so look in both <root> and <root>/data.
    const collections: { baseDir: string; name: string }[] = [];
    for (const baseDir of [root, path.join(root, "data")]) {
        try {
            for (const d of fs.readdirSync(path.join(baseDir, BULK_ROOT_FOLDER), { withFileTypes: true })) {
                if (d.isDirectory()) collections.push({ baseDir, name: d.name });
            }
        } catch { continue; } // no bulkDatabases2 here
    }

    const total = collections.length;
    if (!total) return;
    const passStart = Date.now();
    console.log(`  [autocompact] iterating over ${total} collection(s)`);
    for (let i = 0; i < total; i++) {
        const { baseDir, name } = collections[i];
        const at = `${i + 1} / ${total}`;
        const start = Date.now();
        console.log(`  [autocompact] ${at} ${name}: starting merge`);
        try {
            await getCompactor(baseDir, name).tryMergeNow();
            console.log(`  [autocompact] ${at} ${name}: done (${Date.now() - start}ms)`);
        } catch (e) {
            console.warn(`  [autocompact] ${at} ${name}: failed after ${Date.now() - start}ms - ${(e as Error).message}`);
        }
    }
    console.log(`  [autocompact] done all ${total} collection(s) (${Date.now() - passStart}ms)`);
}

// CLI entry (invoked by bin/filehoster.js or `yarn filehoster <folder>`). Starts the server, logs the
// password + local/public URLs + batched access, and keeps the UPnP port mapping alive.
export async function runFileHoster(): Promise<void> {
    const args = process.argv.slice(2);
    const root = args.find(a => !a.startsWith("--") && !a.endsWith(".ts") && !a.endsWith(".js"));
    if (!root) {
        console.error("Usage: yarn filehoster <folder> [--port N]   (set a fixed password with PASSWORD=...)");
        process.exit(1);
    }
    const portIdx = args.indexOf("--port");
    const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 8787;

    const info = await startRemoteFileServer({ root, port, password: process.env.PASSWORD, logAccess: true });
    let externalIP: string | undefined;
    try { externalIP = (await getExternalIP()).trim(); } catch { /* offline / unreachable */ }

    // What the user types into the app: just the host, plus ":port" only if it's not the default. No
    // scheme — the app always uses https.
    const host = externalIP || "localhost";
    const appAddress = host + (info.port === 8787 ? "" : ":" + info.port);
    const certUrl = "https://" + host + ":" + info.port;
    console.log("");
    console.log("  Serving:   " + path.resolve(root));
    console.log("  Password:  " + info.password);
    console.log("  Address:   " + appAddress + "     <- in the app, choose \"Connect to a server\" and enter this");
    console.log("");
    console.log("  First time only: open  " + certUrl + "  in a browser once and accept the");
    console.log("  self-signed certificate warning, then connect from the app.");
    console.log("");

    // Keep the UPnP port mapping alive — leases expire ~hourly, so refresh well within that. No-op on
    // Linux (forwardPort returns early there).
    const refresh = async () => {
        try { await forwardPort({ externalPort: info.port, internalPort: info.port }); }
        catch (e) { console.warn("  port forwarding failed:", (e as Error).message); }
    };
    await refresh();
    setInterval(refresh, 30 * 60 * 1000);

    console.log("  [access] request logging on (batched every 5s)\n");

    if (args.includes("--autocompact")) {
        // No UI to protect on a host, so don't space merges out — compact promptly each pass.
        bulkDatabase2Timing.mergeSpacingMs = 0;
        console.log("  [autocompact] compacting bulk databases on startup, then every 3h (serial)\n");
        // Fire-and-forget: runs the first pass now and re-runs every 3h. Not awaited, so it doesn't block
        // startup; each pass rescans the disk for new collections and merges them one at a time.
        void runInfinitePollCallAtStart(AUTOCOMPACT_INTERVAL_MS, () => autocompactBulkDatabases(root))
            .catch(e => console.error("  [autocompact] poll error:", (e as Error).stack));
    }
}
