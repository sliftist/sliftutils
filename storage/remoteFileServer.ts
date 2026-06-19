import https from "https";
import type { IncomingMessage, ServerResponse } from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { execFileSync } from "child_process";
import { getExternalIP } from "socket-function/src/networking";
import { forwardPort } from "socket-function/src/forwardPort";

// Remote file server for sliftutils getRemoteFileStorage / BulkDatabase2. Serves one folder on disk over
// self-signed HTTPS, authenticated with an auto-generated 6-word password (sent as
// `Authorization: Bearer <password>`). Run it with `yarn filehoster <folder>` (or the `filehoster` bin).
//
// SECURITY: the cert is self-signed, so a browser must accept it once (open the printed https URL and
// click through), and the Node client connects with cert verification disabled. The password is what
// authorizes access; keep it secret.

// Common, memorable words (frequency-ordered subset) for passphrase generation.
const WORDS: string[] = [
    "that","with","which","this","from","have","they","were","their","there","when","them","said","been",
    "would","will","what","more","then","into","some","could","time","very","than","your","other","upon",
    "about","only","little","like","these","great","after","well","made","before","such","over","should",
    "first","good","must","much","down","where","know","most","here","come","those","never","life","long",
    "came","being","many","through","even","himself","back","every","shall","again","make","without","might",
    "while","same","under","just","still","people","place","think","house","take","last","found","away",
    "hand","went","thought","also","though","three","another","eyes","years","work","right","once","night",
    "young","nothing","against","small","head","left","part","ever","world","each","father","give","between",
    "face","king","things","love","because","took","always","tell","called","water","both","side","look",
    "having","room","mind","half","heart","name","home","country","whole","however","find","among","going",
    "thing","lord","looked","seen","mother","general","done","seemed","told","whom","days","soon","better",
    "letter","woman","heard","asked","course","thus","moment","knew","light","enough","white","almost",
    "until","quite","hands","words","death","large","taken","since","gave","given","best","state","brought",
    "does","whose","door","others","power","perhaps","present","next","morning","poor","lady","four","high",
    "year","turned","less","word","full","during","rather","want","order","near","feet","true","miss",
    "matter","began","cannot","used","known","felt","above","round","thou","voice","till","case","nature",
    "indeed","church","kind","certain","fire","often","stood","fact","friend","girl","five","land","says",
    "john","myself","along","point","dear","wife","city","within","sent","times","keep","passed","form",
    "second","body","money","believe","hundred","open","several","means","child","english","herself","sure",
    "looking","women","already","black","alone","least","gone","held","itself","whether","hope","river",
    "ground","either","number","chapter","england","leave","rest","town","hear","greek","friends","book",
    "hour","short","cried","read","behind","became","making","family","earth","captain","around","dead",
    "reason","call","become","lost","line","replied","help","coming","speak","manner","french","twenty",
    "spirit","really","early","story","hard","close","human","public","truth","strong","master","care",
    "towards","history","kept","later","states","dark","able","mean","return","brother","person","subject",
    "soul","party","arms","thee","seems","common","fell","fine","feel","show","table","turn","wish","evening",
    "free","cause","south","ready","north","across","rose","live","account","doubt","company","miles","road",
    "bring","london","sense","horse","carried","hold","sight","fear","answer","idea","force","need","deep",
    "further","nearly","past","army","blood","street","court","reached","view","school","sort","taking",
    "else","chief","hours","beyond","cold","none","longer","strange","fellow","clear","service","natural",
    "suppose","late","talk","front","stand","purpose","seem","neither","ought","west","real","except","sound",
    "gold","forward","feeling","added","boys","self","peace","happy","living","husband","toward","spoke",
    "fair","france","trees","effect","latter","length","change","died","green","united","fall","pretty",
    "placed","meet","forth","office","comes","pass","written","ship","enemy","saying","tree","foot","blue",
    "note","prince","hair","heaven","wild","play","entered","society","laid","wind","doing","paper","opened",
    "bear","third","queen","mine","greater","various","faith","wanted","boat","stone","lived","george",
    "window","doctor","action","books","tried","letters","makes","minutes","parts","wood","period","duty",
    "york","instead","heavy","persons","battle","field","british","object","century","island","beauty",
    "christ","sister","glad","below","east","opinion","save","places","months","food","sweet","trouble",
    "system","born","desire","works","mary","chance","william","seven","single","hardly","sleep","mouth",
    "horses","silence","ancient","broken","hall","send","rich","girls","besides","lips","henry","figure",
    "slowly","hill","wall","future","lines","follow","german","march","filled","brown","deal","eight",
    "covered","smile","former","week","drew","easy","paris","camp","stay","cross","seeing","result","started",
    "caught","houses","appear","wrote","giving","simple","arrived","formed","bright","wide","uncle","piece",
    "walked","knows","carry","middle","village","holy","merely","getting","raised","afraid","struck",
    "charles","board","visit","royal","spring","dinner","evil","outside","wrong","summer","moved","danger",
    "mark","fresh","plain","thirty","scene","quickly","wonder","jack","indian","walk","learned","class",
    "secret","wait","command","easily","garden","loved","married","fight","leaving","music","usual","cases",
    "winter","respect","value","quiet","please","stopped","write","laughed","america","chair","paid","duke",
    "leaves","lower","colonel","perfect","james","worth","author","finally","youth","regard","glass",
    "picture","built","modern","success","race","showed","tears","unless","mere","lives","grew","charge",
    "beside","remain","waiting","study","hath","shot","unto","tone","iron","watch","grace","flowers","killed",
    "allowed","news","step","proper","sitting","floor","justice","noble","goes","walls","laws","meant",
    "bound","forms","fifty","drawn","private","fast","indians","judge","meeting","usually","sudden","gives",
    "reach","bank","attempt","shore","stop","plan","silent","special","spot","officer","silver","passing",
    "broke","lake","soft","journey","beneath","shown","turning","members","enter","lead","trade","names",
    "escape","troops","bill","corner","rule","ladies","species","rock","similar","running","rate","cast",
    "nation","post","likely","simply","orders","dress","fish","minute","birds","europe","passage","surface",
    "snow","attack","higher","rise","grand","reply","honour","notice","speech","trying","game","writing",
    "closed","rome","example","aunt","learn","morrow","offered","peter","equal","space","page","wished",
    "changed","animal","social","twelve","appears","receive","valley","degree","train","steps","fixed",
    "count","forest","matters","foreign","native","broad","moral","animals","safe","roman","break","pale",
    "memory","warm","trust","yellow","sides","main","bird","reading","coast","pain","grave","forget","move",
    "fortune","madame","proved","forty","lying","quick","wise","jesus","working","surely","looks","seat",
    "divine","touch","loss","paul","heads","spent","ordered","report","caused","thomas","ones","drawing",
    "talking","breath","meaning","month","union","pleased","powers","emperor","laugh","affairs","narrow",
    "square","science","begin","promise","takes","conduct","serious","thank","curious","pieces","health",
    "exactly","ways","upper","decided","nine","stream","wine","engaged","points","amount","named","song",
    "worse","size","castle","crown","mass","liberty","stage","guard","servant","greatly","price","weeks",
    "neck","ears","drink","crowd","thick","fallen","hills","spoken","golden","capital","sign","spite","terms",
    "sake","council","threw","ships","portion","support","clothes","effort","fully","holding","majesty",
    "glory","pure","facts","sword","sorry","fate","bread","prove","station","sharp","dream","vain","major",
    "smiled","instant","spread","serve","sick","june","ideas","thrown","start","weather","gray","courage",
    "anxious","woods","path","rising","grass","moon","gate","forced","fancy","bottom","expect","remains",
    "shook","bishop","watched","settled","events","rain","quarter","heat","palace","glance","kingdom",
    "papers","aside","worthy","taste","pride","july","opening","daily","leading","wounded","famous","offer",
    "group","distant","weight","highest","vast","popular","passion","knowing","allow","sought","lies",
    "marked","series","growing","measure","hearts","robert","obliged","western","hence","style","dropped",
    "nations","grown","honor","edge","pray","tall","frank","poet","streets","season","pointed","mighty",
    "temple","extent","thin","blow","freedom","entire","keeping","prevent","shut","storm","lose","college",
    "cost","marry","spirits","worked","colour","ring","listen","fruit","waters","fashion","share","hung",
    "proud","fingers","method","served","grow","fort","draw","dollars","quietly","yours","vessel","direct",
    "refused","bridge","gods","inside","title","advance","priest","becomes","dick","double","seek","guess",
    "spanish","larger","ball","finding","edward","removed","brave","tired","agreed","sacred","sons","guns",
    "played","richard","devil","pounds","honest","false","cloth","soldier","tongue","smith","wealth","failed",
    "height","faces","equally","legs","pocket","twice","volume","prayer","county","notes","louis","unknown",
    "delight","rights","nice","taught","coat","dare","slight","rocks","enemies","control","forces","germany",
    "kill","process","david","rapidly","comfort","islands","centre","salt","april","windows","noticed",
    "truly","color","fields","date","august","desired","breast","skin","gentle","smoke","search","joined",
    "nobody","results","needed","weak","type","stones","follows","theory","shape","waited","telling","relief",
    "bearing","bent","mile","dressed","birth","spain","female","clearly","moving","drive","crossed","member",
    "saved","teeth","flesh","cover","shows","farther","stands","figures","numbers","bodies","supply","motion",
    "grey","bell","alive","seized","shadow","produce","touched","driven","talked","empire","sunday","pair",
    "fourth","slave","regular","dozen","beat","cousin","sand","soil","rough","claim","angry","pity","walking",
    "acts","pope","rooms","task","stock","tender","throw","reader","india","hotel","fifteen","arrival",
    "plate","stars","willing","stories","saint","amongst","virtue","chamber","civil","yards","habit","writer",
    "putting","origin","italy","hearing","genius","milk","busy","fool","burning","duties","brain","slow",
    "belief","bore","mention","grant","library","inches","press","calm","total","ride","lands","labor",
    "parties","clean","catch","treated","rode","whilst","level","efforts","minds","welcome","wisdom","supper",
    "final","mercy","aware","lovely","empty","wants","midst","central","rank","proof","burst","term","farm",
    "applied","loud","nearer","harry","closely","kings","explain","deck","noise","hurt","advice","absence",
    "circle","objects","secure","plants","parents","falling","base","fellows","sorrow","flat","flower",
    "calling","imagine","range","sold","favour","happen","showing","earl","hole","careful","dust","prison",
    "useful","accept","firm","sing","port","seated","custom","wore","doors","lifted","edition","tale",
    "affair","policy","roof","express","ahead","worship","partly","address","highly","victory","ocean",
    "begun","buried","content","smiling","liked","active","quality","philip","current","divided","growth",
    "huge","moments","article","speed","poetry","machine","join","nose","unable","ceased","gained","worn",
    "eastern","safety","ages","vessels","hopes","corn","slaves","drop","plant","evident","local","police",
    "october","obtain","italian","deeply","dying","wholly","dogs","playing","plenty","apart","suffer","maid",
    "record","fairly","kindly","terror","drove","ends","sugar","capable","irish","message","chosen","flight",
    "reasons","couple","meat","printed","blind","energy","bitter","baby","mistake","tower","ireland","trial",
    "wear","brief","market","band","causes","clouds","goods","admit","cities","earlier","tells","stated",
    "pressed","crime","fought","guide","hoped","list","banks","knight","fleet","pulled","tail","patient",
    "mental","boats","kinds","stairs","star","cattle","rare","wings","disease","section","actual","bare",
    "extreme","cruel","worst","escaped","dance","strike","views","eggs","needs","store","choice","fond",
    "adopted","suit","singing","fail","souls","thanks","hidden","shame","faint","shop","older","joseph",
    "knees","gently","blessed","yard","cent","grief","male","sooner","january","excited","region","praise",
    "throne","classes","effects","demand","gain","fault","labour","variety","loose","cook","devoted","ended",
    "changes","witness","bought","lover","visited","club","sheep","cloud","enjoy","asleep","cool","dull",
    "painted","arose","armed","dignity","chiefly","voices","sail","event","signs","hero","schools","branch",
    "hurried","arthur","kitchen","stick","coffee","thinks","eager","natives","flying","boston","eternal",
    "source","fill","anger","vision","murder","viii","park","avoid","awful","raise","desert","plans","pardon",
    "assured","wound","finger","bible","rear","details","cabin","whence","reign","weary","slavery","visible",
    "shouted","seldom","skill","hast","throat","reality","leader","egypt","credit","smaller","severe","calls",
    "younger","shell","sprang","anybody","handed","despair","asking","inch","mystery","manners","knife",
    "design","sounds","wishes","stepped","towns","sixty","immense","china","favor","latin","hate","setting",
    "excuse","chinese","behold","rushed","choose","ease","lights","paused","mission","voyage","gift","bold",
    "meal","britain","smooth","mounted","utterly","lest","helped","picked","falls","pipe","bones","earnest",
    "granted","swept","anxiety","teach","waves","softly","savage","hunting","defence","rapid","artist",
    "recent","supreme","russian","created","habits","exist","guilty","pages","crew","hell","remark","request",
    "harm","solemn","observe","trail","copy","violent","dreams","proceed","luck","steel","sell","temper",
    "appeal","hide","fled","belong","triumph","abroad","waste","consent","writers","possess","jews","require",
    "priests","railway","founded","pushed","host","solid","maybe","degrees","cheeks","mount","ruin","owing",
    "fierce","reduced","mankind","text","swift","riding","silk","shade","career","wicked","afford","alas",
    "rules","treaty","correct","spend","foolish","methods","remarks","horror","shining","enjoyed","tribes",
    "lack","frame","gets","eagerly","russia","alike","somehow","nodded","problem","fever","sees","stern",
    "dawn","forgive","flag","managed","fame","travel","estate","cotton","hurry","agree","feared","kiss",
    "million","martin","mixed","risk","butter","jane","assumed","pause","benefit","unhappy","lighted",
    "scheme","slept","plainly","forgot","delay","merry","rush","wooden","secured","poem","rolled","angel",
    "guests","farmer","humble","glanced","shortly","rope","image","lately","africa","fired","retired","bull",
    "steam","keen","loving","borne","readily","beloved","average","teacher","attend","flame","area","burned",
    "thrust","negro","nurse","spare","fifth","thence","roads","refuse","tent","kissed","gates","gaze","fatal",
    "israel","verse","scenes","confess","uttered","build","acted","hanging","reward","issue","utmost",
    "fathers","noted","widow","related","urged","mode","failure","nervous","render","masters","tribe",
    "colored","turns","alarm","rivers","using","eleven","rage","hers","lamp","retreat","amid","gospel",
    "exposed","johnson","marks","tide","emotion","destroy","inner","sisters","lion","helen","tied","grounds",
    "acid","wheel","issued","invited","gazed","senate","finds","seed","regret","clay","chain","crowded",
    "bosom","limited","steady","chap","anne","francis","cavalry","freely","charm","faced","ideal","useless",
    "warning","shelter","vote","xpage","cottage","beast","outer","folks","misery","anyone","expense","firmly",
    "eating","lonely","owner","trace","coal","hastily","elder","utter","begins","chapel","nights","dared",
    "signal","stared","track","lords","speaks","bottle","blame","claims","shoes","sigh","ghost","folk",
    "dutch","flung","flew","cheek","staff","walter","clever","acting","hungry","poems","cutting","forever",
    "exact","haste","dancing","trip","lincoln","pull","vice","slipped","thine","loves","permit","mill",
    "engine","hollow","seeking","bowed","largely","charged","painful","madam","roll","leaf","prayers",
    "element","agent","cries","songs","theatre","creek","match","ashamed","runs","aspect","canada","treat",
    "legal","arts","corps","noon","nearest","scale","hunt","shadows","winds","landed","beings","tiny",
    "gardens","bless","clerk","doth","derived","hang","heavens","cape","ours","brow","test","senses",
    "opposed","error","driving","nest","headed","groups","princes","feast","admiral","poured","brings",
    "pursued","germans","bears","lesson","journal","unusual","marched","wing","remove","studied","passes",
    "actions","burden","colony","scott","bride","yield","crying","forming","rifle","powder","rested","shake",
    "guest","begged","occur","altar","sorts","beaten","wave","papa","sang","depth","aloud","contact",
    "intense","marble","poverty","detail","writes","root","metal","jean","existed","ability","purple",
    "counsel","lane","wives","sending","heavily","leaders","queer","tales","sins","mexico","protect","clock",
    "stuff","jones","pine","records","cave","baron","medical","pick","stayed","magic","seventy","pour",
    "saddle","sank","dread","deny","wire","rude","holds","strain","autumn","shed","shoot","settle","basis",
    "readers","route","beach","safely","oxford","notion","thunder","sale","saints","pound","shock","elected",
    "signed","whereas","maiden","courts","rarely","wolf","mamma","billy","student","charity","impulse",
    "tones","mortal","raising","wedding","belongs","chest","sharply","sounded","poets","lawyer","hugh",
    "plays","awake","landing","debt","alice","venture","idle","uniform","contain","tobacco","boots","fears",
    "leaned","studies","customs","prize","stir","obey","oath","badly","pursuit","resting",
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
    const password = options.password || generatePassword(6);
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
            for (const e of rows) console.log(`  [${e.op}] ${e.ip}  ${e.path}  ${e.count}x  ${formatBytes(e.bytes)}`);
        }, 5000);
        flushTimer.unref?.();
    }
    const clientIp = (req: IncomingMessage) => (req.socket.remoteAddress || "?").replace(/^::ffff:/, "");

    const server = https.createServer({ key, cert }, async (req: IncomingMessage, res: ServerResponse) => {
        const origin = (req.headers["origin"] as string) || "*";
        const cors: Record<string, string> = {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "authorization, content-type",
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

            const auth = (req.headers["authorization"] as string) || "";
            const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
            if (!timingSafeEqualStr(normalizePassword(token), normPassword)) return sendJson(401, { error: "unauthorized" });

            const url = new URL(req.url || "/", "https://localhost");
            const op = url.pathname;
            const relPath = url.searchParams.get("path") || "";
            const full = safeResolve(root, relPath);
            if (full === undefined) return sendJson(403, { error: "path escapes root" });

            if (req.method === "GET" && op === "/list") {
                const wantFolders = url.searchParams.get("folders") === "1";
                let entries: fs.Dirent[];
                try { entries = fs.readdirSync(full, { withFileTypes: true }); }
                catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? sendJson(200, []) : sendJson(500, { error: (e as Error).message }); }
                return sendJson(200, entries.filter(d => wantFolders ? d.isDirectory() : d.isFile()).map(d => d.name));
            }
            if (req.method === "GET" && op === "/info") {
                let st: fs.Stats;
                try { st = fs.statSync(full); } catch { return sendJson(404, { error: "not found" }); }
                return sendJson(200, { size: st.size, lastModified: st.mtimeMs });
            }
            if (req.method === "GET" && op === "/hasDir") {
                let st: fs.Stats; try { st = fs.statSync(full); } catch { return sendJson(200, { exists: false }); }
                return sendJson(200, { exists: st.isDirectory() });
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
            if ((req.method === "PUT" || req.method === "POST") && (op === "/append" || op === "/set")) {
                const body = await readBody(req);
                fs.mkdirSync(path.dirname(full), { recursive: true });
                if (op === "/append") fs.appendFileSync(full, body);
                else fs.writeFileSync(full, body);
                recordAccess(clientIp(req), "write", relPath, body.length);
                return sendJson(200, { ok: true });
            }
            if (req.method === "DELETE" && op === "/remove") {
                try { fs.unlinkSync(full); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return sendJson(500, { error: (e as Error).message }); }
                return sendJson(200, { ok: true });
            }
            if (req.method === "DELETE" && op === "/removeDir") {
                try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) { return sendJson(500, { error: (e as Error).message }); }
                return sendJson(200, { ok: true });
            }
            if (req.method === "POST" && op === "/reset") {
                try { for (const name of fs.readdirSync(full)) fs.rmSync(path.join(full, name), { recursive: true, force: true }); }
                catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return sendJson(500, { error: (e as Error).message }); }
                return sendJson(200, { ok: true });
            }
            return sendJson(404, { error: "unknown endpoint" });
        } catch (e) {
            try { sendJson(500, { error: String((e as Error)?.message || e) }); } catch { /* response already sent */ }
        }
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
                close: () => new Promise<void>(r => { if (flushTimer) clearInterval(flushTimer); server.close(() => r()); }),
            });
        });
    });
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

    console.log("");
    console.log("  Serving:   " + path.resolve(root));
    console.log("  Password:  " + info.password);
    console.log("  Local:     " + info.url);
    if (externalIP) console.log("  Public:    https://" + externalIP + ":" + info.port + "   (once port-forwarding succeeds)");
    console.log("");
    console.log("  In the app, choose \"Connect to a server\" and enter the URL + password.");
    console.log("  (Self-signed cert: open the URL once in your browser and accept it first.)");
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
}
