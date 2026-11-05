// Terminal lines the live log must never carry as-is. `secret` must be gone
// from the redacted line; `keep` must still be there. Every secret-shaped value
// is fabricated and assembled at run time, so the secret scanner never sees a
// credential-shaped literal in the repo.

// A macOS home folder, assembled at run time like the secrets.
export const USERS = ["", "Users", ""].join("/");
const HOME = `${USERS}somebody`;

/** @param {string[]} parts */
const cat = (...parts) => parts.join("");

export const GH_TOKEN = cat("gh", "p_", "A1b2C3d4E5f6G7h8I9j0", "K1l2M3n4O5p6Q7r8");
const GH_PAT = cat("github", "_pat_", "11ABCDEFG0123456789", "_abcdefghijklmnopqrstuvwxyz0123456789");
const ANTHROPIC = cat("sk-", "ant-", "api03-Zx9Yw8Vu7Ts6Rq5Po4", "Nm3Lk2Ji1Hg0Fe");
const OPENAI = cat("sk-", "proj-", "Qw3Er4Ty5Ui6Op7As8Df9", "Gh0Jk1Lz2Xc3");
const FLY = cat("fo", "1_", "Zq8Wm3Nx5Kp2Lr7Vt4Yb9", "Hc6Jd1Fs0Ga");
const FLY_V1 = cat("fm2_", "lJPECAAAAAAAB8Qa4k2m9p");
const AWS = cat("AK", "IA", "QWERTYUIOPASDFGH");
const SLACK = cat("xo", "xb-", "123456789012-abcdefghijkl");
const GOOGLE = cat("AI", "za", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q");
const JWT_HEAD = cat("ey", "JhbGciOiJIUzI1NiJ9");
const JWT_SIG = cat("dozjgNryP4J3jVmNHl0w5N", "_XgL0n3I9PlFUP0THsR8U");
const BEARER = cat("abcdef0123", "456789abcdef");
const DB_PASS = cat("Sup3r", "S3cret");
const QUERY = cat("zzTop5ecret", "Value99");
const CLIENT_SECRET = cat("shh-its-a-", "secret-value");
const BOARD = cat("b0a1r2d3", "t4o5k6e7n8");
const FLAG = cat("9f8e7d6c5b", "4a39281706");
const KEY_BODY = cat("b3BlbnNzaC1rZXktdjEAAAAA", "BG5vbmU");
const HEX64 = cat("9b1f0c2e8d7a6b5c", "4d3e2f1a0b9c8d7e", "6f5a4b3c2d1e0f9a", "8b7c6d5e4f3a2b1c0");
const SHA = cat("4f2c9e1a7b3d5f6e", "8a0c2b4d6f8e0a1c3b5d7f9e");
const SESSION = ["f2278f2d", "dedd", "4c68", "bb6c", "c2f5b068cba1"].join("-");
const RANDOM = cat("Zx8Qp2Lm7Rt4Vw9Ks3Nb", "6Hy1Jc5Gd0Fa2Xe");
const B64 = cat("dGhpcyBpcy9hIHNlY3JldC9rZXkv", "dmFsdWUrYmFzZTY0Kz09");
const SLASHY = cat("Ab9Cd8Ef7Gh6J/Kl5Mn4", "Op3Qr2S/Tu1Vw0Xy9Za8");
const LEAD = cat("Ab9Cd8Ef7Gh6JKl5Mn4", "Op3Qr2STu1Vw0Xy9Za8");
const PW = cat("hunter", "2-Xq9");
const SPACED = cat("correct horse ", "battery staple");
const UPPER_RUN = cat("ABCDEFGHIJKLMNOP", "QRSTUVWXYZ012345");
const MIXED_RUN = cat("qjVZrmaCBLyFPuND", "wEXkhtGsAoUiQvR1");
const AWS_SECRET = cat("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY");
const LOWER_RUN = cat("q7m2v9k4z8p1w6r3", "n5t0h2j9s4x8b1c6");
const LOWER_LETTERS = cat("xkqzvbwmtrplgnhd", "fjcsyrkvqzwx");
export const KEY_BEGIN = cat("-----BEGIN RSA ", "PRIVATE KEY-----");
export const KEY_END = cat("-----END RSA ", "PRIVATE KEY-----");

/** @type {{ line: string, secret: string[], keep?: string[] }[]} */
export const REDACT = [
  { line: `export GH_TOKEN=${GH_TOKEN}`, secret: [GH_TOKEN], keep: ["GH_TOKEN="] },
  { line: `token: ${GH_PAT}`, secret: [GH_PAT.slice(0, 30)] },
  { line: `ANTHROPIC_API_KEY=${ANTHROPIC}`, secret: [ANTHROPIC] },
  { line: `using key ${OPENAI}`, secret: [OPENAI] },
  { line: `fly secrets: ${FLY}`, secret: [FLY] },
  { line: `Authorization: ${cat("Fly", "V1")} ${FLY_V1},${cat("fm2", "_x7yZqW")}`, secret: [FLY_V1] },
  { line: `aws_access_key_id = ${AWS}`, secret: [AWS] },
  { line: `SLACK=${SLACK}`, secret: [SLACK] },
  { line: `maps key ${GOOGLE}`, secret: [GOOGLE] },
  { line: `cookie ${JWT_HEAD}.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${JWT_SIG}`, secret: [JWT_HEAD, JWT_SIG] },
  { line: `curl -H 'Authorization: Bearer ${BEARER}' https://x`, secret: [BEARER], keep: ["Authorization"] },
  { line: `DATABASE_URL=postgres://app:${DB_PASS}@db.internal:5432/app`, secret: [DB_PASS] },
  { line: `connecting to postgres://app:${DB_PASS}@db.internal:5432/app`, secret: [DB_PASS], keep: ["db.internal"] },
  { line: `https://u:${DB_PASS}TOKEN=foo@host TOKEN=[`, secret: [DB_PASS] },
  { line: `GET /cb?code=1&access_token=${QUERY}&x=1`, secret: [QUERY], keep: ["code=1"] },
  { line: `{"client_secret": "${CLIENT_SECRET}"}`, secret: [CLIENT_SECRET] },
  { line: `RIVET_BOARD_TOKEN='${BOARD}'`, secret: [BOARD] },
  { line: `node push-board.mjs --token ${FLAG}`, secret: [FLAG] },
  { line: `${KEY_BEGIN} ${KEY_BODY}`, secret: [KEY_BODY] },
  { line: `blob ${HEX64}`, secret: [HEX64] },
  { line: `value ${RANDOM}`, secret: [RANDOM] },
  { line: `b64 ${B64}`, secret: [B64] },
  { line: `edited ${HOME}/Documents/GitHub/Example-Org/rivet/src/x.ts`, secret: [HOME, "somebody"], keep: ["~/Documents/GitHub/Example-Org/rivet/src/x.ts"] },
  { line: `value ${SLASHY}`, secret: [SLASHY, "Kl5Mn4"] },
  { line: `value ${UPPER_RUN}`, secret: [UPPER_RUN, "QRSTUV"] },
  { line: `value ${MIXED_RUN}`, secret: [MIXED_RUN, "wEXkht"] },
  { line: `aws_secret ${AWS_SECRET}`, secret: [AWS_SECRET, "wJalrX", "K7MDENG", "EXAMPLEKEY"] },
  { line: `cat /${AWS_SECRET} ./${MIXED_RUN}`, secret: ["wJalrX", "K7MDENG", MIXED_RUN], keep: ["cat "] },
  { line: `cat /${LEAD}`, secret: [LEAD, "Mn4Op3"] },
  { line: `cat /${SLASHY}`, secret: [SLASHY, "Kl5Mn4"] },
  { line: `open ~/${LEAD}/x.txt`, secret: [LEAD], keep: ["open ~"] },
  { line: `cd ${USERS}x/work/spaces/Example-Org/chat`, secret: [], keep: ["~/work/spaces/Example-Org/chat"] },
  {
    line: `wrote /private/tmp/claude-502/-Users-x-work-spaces-Example-Org-rivet-app/${SESSION}/scratchpad/v2-command/shots.log`,
    secret: [],
    keep: [`/private/tmp/claude-502/-Users-x-work-spaces-Example-Org-rivet-app/${SESSION}/scratchpad/v2-command/shots.log`],
  },
  { line: "at node_modules/.pnpm/@scope+pkg@1.2.3/node_modules/x/dist/index.js:12", secret: [], keep: ["node_modules/.pnpm/@scope+pkg@1.2.3/node_modules/x/dist/index.js:12"] },
  { line: "cd ~/Documents/GitHub/Example-Org/.claude/worktrees/agent-acffa496d87bf4965/rivet", secret: [], keep: ["~/Documents/GitHub/Example-Org/.claude/worktrees/agent-acffa496d87bf4965/rivet"] },
  { line: `read reports/${SHA}/summary.json`, secret: [], keep: [`reports/${SHA}/summary.json`] },
  { line: "built dist/assets/index-B7xK2mQp.js and dashboard/docs/evidence/dashboard-math-5x6-1.json", secret: [], keep: ["dist/assets/index-B7xK2mQp.js", "dashboard/docs/evidence/dashboard-math-5x6-1.json"] },
  { line: "./node_modules/.bin/vitest run test/command-dom.test.ts --reporter=verbose", secret: [], keep: ["./node_modules/.bin/vitest run test/command-dom.test.ts"] },
  { line: `psql --password  ${PW} -h db`, secret: [PW], keep: ["--password", "-h db"] },
  { line: `deploy --db-password "${SPACED}" --app x`, secret: ["horse", "staple"], keep: ["--app x"] },
  { line: `deploy --api-key='${SPACED}'`, secret: ["horse", "staple"] },
  { line: `PASSWORD="${SPACED}" ./run.sh`, secret: ["horse", "staple"], keep: ["./run.sh"] },
  { line: `sshpass -p ${PW} ssh deploy@host`, secret: [PW], keep: ["ssh deploy@host"] },
  { line: `sshpass -p '${SPACED}' ssh host`, secret: ["horse", "staple"] },
  { line: `mysql -u root -p${PW} app`, secret: [PW] },
  { line: `redis-cli -a ${PW} ping`, secret: [PW], keep: ["ping"] },
  { line: `curl -u admin:${PW} https://x`, secret: [PW], keep: ["admin:"] },
  { line: `curl --user=admin:${PW} https://x`, secret: [PW], keep: ["--user=admin:", "https://x"] },
  { line: `curl -u 'admin:${SPACED}' https://x`, secret: ["admin:correct", "horse", "staple"], keep: ["curl -u", "https://x"] },
  { line: `curl --user "admin:${SPACED}" https://x`, secret: ["horse", "staple"], keep: ["https://x"] },
  { line: `curl -uadmin:${PW} https://x`, secret: [PW], keep: ["curl -uadmin:", "https://x"] },
  { line: `curl -u'admin:${SPACED}' https://x`, secret: ["horse", "staple"], keep: ["https://x"] },
  { line: `curl -x proxy:3128 -Uproxy:${PW} https://x`, secret: [PW], keep: ["-Uproxy:", "https://x"] },
  { line: `curl -uadmin:"${SPACED}" https://example.com`, secret: ["correct", "horse", "battery", "staple"], keep: ["curl -uadmin:", "https://example.com"] },
  { line: `curl --user admin:"${SPACED}" https://x`, secret: ["correct", "horse", "staple"], keep: ["--user admin:", "https://x"] },
  { line: `curl --user=admin:'${SPACED}' https://x`, secret: ["correct", "horse", "staple"], keep: ["--user=admin:", "https://x"] },
  { line: `curl --proxy-user proxy:pre"${SPACED}"post https://x`, secret: ["pre", "horse", "staple", "post"], keep: ["--proxy-user proxy:", "https://x"] },
  { line: `curl -Uproxy:"a \\" ${SPACED}" https://x`, secret: ["horse", "staple"], keep: ["-Uproxy:", "https://x"] },
  { line: "curl -u admin:correct\\ horse\\ battery https://x", secret: ["correct", "horse", "battery"], keep: ["-u admin:", "https://x"] },
  { line: `curl -u "admin":"${SPACED}" https://x`, secret: ["admin", "horse", "staple"], keep: ["curl -u", "https://x"] },
  { line: `curl -uadmin:"${SPACED}`, secret: ["horse", "staple"], keep: ["curl -uadmin:"] },
  { line: "git push -u origin main && curl -u admin https://x", secret: [], keep: ["git push -u origin main", "curl -u admin https://x"] },
  { line: `sshpass -p'${SPACED}'x ssh host`, secret: ["horse", "staple"], keep: ["ssh host"] },
  { line: `API_TOKEN=abc"${SPACED}" ./run.sh`, secret: ["horse", "staple"], keep: ["./run.sh"] },
  { line: `{"password":"first","token": "abc123"}`, secret: ["first", "abc123"], keep: [`{"password":"[redacted]","token": "[redacted]"}`] },
  { line: `{"api_key":"${PW}","client_secret":"sec-${PW}","user":"bob","session":"s-${SPACED}"}`, secret: [PW, "horse", "staple"], keep: [`"user":"bob"`] },
  { line: `{"db":{"password":"${PW}","host":"db.internal"},"auth":{"token":"tok-${PW}"}}`, secret: [PW], keep: [`"host":"db.internal"`, `"auth":[redacted]`] },
  { line: `{"password":"a\\"b ${SPACED}\\"c","user":"bob"}`, secret: ["horse", "staple", "\\\"c"], keep: [`"password":"[redacted]","user":"bob"`] },
  { line: `    "token": "${PW}",`, secret: [PW], keep: [`"token": "[redacted]",`] },
  { line: `  "refresh_token": "${SPACED}", "expires_in": 3600`, secret: ["horse", "staple"], keep: [`"expires_in": 3600`] },
  { line: `const cfg = { password: '${PW}', apiKey: "${PW}x", name: 'ok' }`, secret: [PW], keep: ["password: '[redacted]'", `apiKey: "[redacted]"`, "name: 'ok' }"] },
  { line: `  db_password: '${SPACED}'`, secret: ["horse", "staple"], keep: ["db_password: '[redacted]'"] },
  { line: `secret: 'it''s ${SPACED}' # yaml`, secret: ["horse", "staple"], keep: ["# yaml"] },
  { line: `TOKEN="${PW}",next=1`, secret: [PW], keep: ["next=1"] },
  { line: `export PGPASSWORD="${SPACED}\\`, secret: ["correct", "horse", "staple"], keep: ["export PGPASSWORD="] },
  { line: `sshpass -p "${SPACED}\\`, secret: ["correct", "horse", "staple"], keep: ["sshpass -p"] },
  { line: `curl -uadmin:"${SPACED}\\`, secret: ["correct", "horse", "staple"], keep: ["curl -uadmin:"] },
  { line: `redis-cli -a${PW} ping`, secret: [PW], keep: ["ping"] },
  { line: `sshpass -p${PW} ssh host`, secret: [PW], keep: ["ssh host"] },
  { line: `zip -P ${PW} out.zip notes.txt`, secret: [PW] },
  { line: `7z x backup.7z -p${PW}`, secret: [PW], keep: ["7z x backup.7z"] },
  { line: "mkdir -p rivet/web/src && mysql -P 3306 -h db", secret: [], keep: ["mkdir -p rivet/web/src", "-P 3306"] },
  { line: `value ${LOWER_RUN}`, secret: [LOWER_RUN, "q7m2v9"] },
  { line: `cat ./${LOWER_RUN}/x.json ~/${LOWER_LETTERS}`, secret: [LOWER_RUN, LOWER_LETTERS], keep: ["cat "] },
  {
    line: "wrote reports/exampleorgsomeowner/typescriptlanguageserver/dashboardmath5x6evidence/rollupdarwinarm64.json",
    secret: [],
    keep: ["reports/exampleorgsomeowner/typescriptlanguageserver/dashboardmath5x6evidence/rollupdarwinarm64.json"],
  },
  {
    line: "at node_modules/.pnpm/@testing-library+react@16.3.3_@types+reac_zrya4r5j5ovatl3luttcvpq3k4/node_modules/x/index.js",
    secret: [],
    keep: ["node_modules/.pnpm/@testing-library+react@16.3.3_@types+reac_zrya4r5j5ovatl3luttcvpq3k4/node_modules/x/index.js"],
  },
  { line: `cd ${USERS}otherperson/rivet-agents`, secret: ["otherperson"], keep: ["~/rivet-agents"] },
  { line: "ls /home/runner/work", secret: ["runner"], keep: ["~/work"] },
  { line: "\u001b[31mred\u001b[0m and \u001b]0;title\u0007 text\u0000", secret: ["\u001b", "\u0007", "\u0000"], keep: ["red and", "text"] },
  { line: `commit ${SHA} merged`, secret: [], keep: [SHA] },
  { line: "rivet/web/src/views/worker-sheet.ts: 42 lines changed", secret: [], keep: ["rivet/web/src/views/worker-sheet.ts"] },
  { line: "Test Files  13 passed (13) at 2026-09-28T03:55:18.875Z", secret: [], keep: ["13 passed", "2026-09-28T03:55:18.875Z"] },
  { line: "https://github.com/example-org/example-repo/pull/2176", secret: [], keep: ["github.com/example-org/example-repo/pull/2176"] },
  // A BEL ends only an OSC: in a C1 DCS, SOS, PM or APC string it is part of the string.
  { line: "pas\u0090qnoise\u0007junk\u009csword: hunter2", secret: ["hunter2"] },
  { line: "pas\u0098noise\u0007junk\u009csword: hunter2", secret: ["hunter2"] },
  // Markdown marks around a secret's key, before or after its separator.
  { line: `**password**: ${PW}`, secret: [PW] },
  { line: `*token*: ${PW}`, secret: [PW] },
  { line: `\`api_key\`: ${PW}`, secret: [PW] },
  { line: `~~secret~~: ${PW}`, secret: [PW] },
  { line: `**\`DB_PASSWORD\`** = ${PW}`, secret: [PW] },
  { line: `"**password**": "${SPACED}", "user": "bob"`, secret: ["horse", "staple"] },
  { line: `__"password"__: ${PW}`, secret: [PW] },
  { line: `- **Password:** ${PW}`, secret: [PW] },
  { line: `ENV_**PASSWORD**: ${PW}`, secret: [PW] },
  { line: `DB_**password**: ${PW}`, secret: [PW] },
  { line: `prefix**password**: ${PW}`, secret: [PW] },
  { line: "**Round** ends: soon and **Why:** `scripts/x.mjs`", secret: [], keep: ["**Round** ends: soon and **Why:** `scripts/x.mjs`"] },
];

export { HOME };
