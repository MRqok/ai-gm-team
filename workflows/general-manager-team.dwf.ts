/* zcode-workflow
description: 总经理团队
  v2.0:老板下达一个任务,总经理设计整体架构、拆成工作包派给多名员工并行完成;成果由总经理逐包审核、打回返工,再经独立审读员把关,最后汇总成交付报告呈给老板。
whenToUse: 当用户想把一个完整任务全权交给"总经理团队"分工协作完成,而不是主对话逐步去做时。必传 task(老板的任务描述);可选
  maxRounds(返工轮数上限)、maxWorkers(最多工作包数)。
args:
  maxRounds:
    type: number
    description: 审核返工轮数上限
    default: 2
  maxWorkers:
    type: number
    description: 最多拆成几个工作包
    default: 6
  task:
    type: string
    description: 老板交办给总经理的完整任务描述
    required: true
*/
// 总经理团队 v2.0:老板下达任务 → 总经理拆解分工 → 员工并行完成 → 总经理审核返工 → 独立审读把关 → 总经理汇总交付
// v2.0 变更:新增独立审读员(交付前冷读把关)、总经理可向老板请示关键决策、返工轮数与工作包数改为可调参数
const task = typeof args.task === "string" ? args.task.trim() : "";
if (task.length === 0) {
  return {
    conclusion: "没有收到任务:请以 task 参数传入老板交办的任务内容。",
    packages: [],
    openIssues: ["未提供任务内容"],
    verified: [],
    notCovered: ["全部——没有任务可执行"],
  };
}

// 可调参数:来自运行参数,未传时用默认值
const maxRounds = typeof args.maxRounds === "number" && args.maxRounds >= 1 ? args.maxRounds : 2;
const maxWorkers = typeof args.maxWorkers === "number" && args.maxWorkers >= 1 ? args.maxWorkers : 6;

interface WorkPackage {
  /** 员工的职位名,如"市场调研员""前端工程师" */
  role: string;
  /** 这个工作包要达成什么,一两句话 */
  objective: string;
  /** 具体要求、边界与验收标准 */
  requirements: string;
  /** 与其他工作包的衔接约定:依赖谁、给谁输出什么格式 */
  handoff: string;
}
interface Plan {
  /** 300字以内:任务怎么理解、分几块、为什么这样分、最后如何拼装 */
  architecture: string;
  /** 成果输出目录名:简短中文、能区分这个任务,不含路径分隔符和特殊字符 */
  outputDir: string;
  /** 2-6 个工作包,合起来恰好覆盖整个任务,不重叠不遗漏 */
  packages: WorkPackage[];
}
interface WorkerResult {
  /** 150字以内:完成了什么、核心结论是什么 */
  summary: string;
  /** 成果文件的 workspace 相对路径(就是让你写的那个) */
  deliverablePath: string;
  /** 100字以内:衔接事项、关键假设、未覆盖处;没有则写"无" */
  notes: string;
}
interface PackageVerdict {
  /** 工作包序号,从 1 开始 */
  packageNo: number;
  /** 是否通过验收 */
  pass: boolean;
  /** 不通过:具体哪里不合格、要怎么改;通过:一句话认可理由 */
  feedback: string;
}
interface Review {
  /** 每个工作包一条裁决 */
  verdicts: PackageVerdict[];
  /** 跨工作包的衔接问题;没有则为空字符串 */
  integrationIssues: string;
}
interface ReaderReport {
  /** 发现的问题清单,每条一句话(写清位置和问题);确无问题则空数组 */
  issues: string[];
}
interface FinalDelivery {
  /** 两三句话:老板的任务完成得怎么样 */
  conclusion: string;
  /** 完整交付报告全文(Markdown),老板直接阅读的内容 */
  reportMarkdown: string;
  /** 需要老板知晓或拍板的事项,每条一句话;没有则空数组 */
  openIssues: string[];
}

const GM_PERSONA =
  "你是一位经验丰富、对结果负责的总经理,直接向老板(用户)汇报。老板把任务全权交给你,你的职责是:吃透任务并设计整体架构;把任务拆成边界清晰、可并行、最后拼得起来的工作包,派给职位合适的员工;员工交回成果后,你以挑剔的标准逐包验收,宁可打回返工也不放过明显缺陷;全部合格(或到达轮次上限)后,由你亲自汇总成交付报告呈给老板。你汇报时要诚实:做得好的、有欠缺的、没验证的,分开说清楚。如果发现任务本身有矛盾或说不通,如实说明,不要硬做。遇到方向性取舍、需要花钱、或超出任务范围的关键决策,先停下向老板请示,不要擅自拍板。全程用中文。";
const WORKER_PERSONA =
  "你是一名能干、靠谱的员工,只负责总经理分派给你的那一个工作包。你可以使用全部工具:读写工作区文件、检索资料、运行命令做验证。把成果整理成一份完整、自成一体、拿来就能用的文件,交给总经理验收;涉及代码、数据或事实性内容时,先自行验证再交付。如果发现任务说不通、与同事的分工冲突,或者超出你的能力,如实说明,不要编造。只写总经理指定给你自己的成果文件,不要改动工作区里的其他文件。全程用中文。";
const READER_PERSONA =
  "你是一位挑剔的独立审读员,从没参与过这个项目,以一个忙碌老板的视角工作。你会拿到一份AI团队写给老板的交付报告和相关成果文件路径;你的任务是只凭阅读挑毛病:哪些结论没有依据、哪些地方写得不清楚或前后矛盾、老板读完最可能追问什么。你可以打开成果文件核对报告里的说法,但绝不修改任何文件,也不负责改写报告。发现问题就如实列出;确实没有问题就返回空数组,不要为了凑数硬挑。用中文。";

// 工作包进度板:运行过程中每个员工的状态实时可见
artifact.board("progress", {
  title: "工作包进度",
  key: "packageNo",
  status: "status",
  columns: ["执行中", "待审核", "返工中", "已通过", "未达标"],
  cardTitle: "role",
  detail: [{ field: "note", label: "说明" }],
});

const gm = agent("总经理", { system: GM_PERSONA });

phase("总经理拆解任务并设计分工");
const plan = await gm.ask<Plan>([
  "老板把下面这个任务全权交给了你:",
  "",
  task,
  "",
  "请拿出整体方案与分工:",
  "1. architecture:先吃透任务,给出整体架构——怎么理解、分几块、为什么这样分、各块最后如何拼装;",
  "2. outputDir:给这次任务的成果起一个简短的中文目录名;",
  "3. packages:拆成 2-" + maxWorkers + " 个工作包,每个包有明确的职位名、目标、要求与验收标准、衔接约定;边界要清晰,能并行推进,合起来恰好覆盖整个任务;任务简单时可以少拆。",
  "",
  "返回 Plan。",
].join("\n"));

function sanitizeDirName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|.\s]/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 40) : "总经理团队成果";
}

const rawPackages = plan.packages.slice(0, maxWorkers);
const packages: WorkPackage[] =
  rawPackages.length > 0
    ? rawPackages
    : [{ role: "全能员工", objective: task, requirements: "完整地完成任务,成果自成一体", handoff: "无" }];
const dirName = sanitizeDirName(plan.outputDir);
const outPaths = packages.map((_pkg, i) => dirName + "/工作包" + (i + 1) + ".md");
const workers: Agent[] = packages.map((pkg, i) => agent("员工" + (i + 1) + "·" + pkg.role, { system: WORKER_PERSONA }));
const workerResults: (WorkerResult | undefined)[] = packages.map(() => undefined);
const verdictByNo: (PackageVerdict | undefined)[] = packages.map(() => undefined);
let integrationIssues = "";

function packageLabel(no: number): string {
  return "工作包" + no + "·" + packages[no - 1].role;
}
function buildWorkerAsk(i: number): string {
  const pkg = packages[i];
  const others = packages
    .map((p, j) => ({ p, j }))
    .filter((x) => x.j !== i)
    .map((x) => (x.j + 1) + ". " + x.p.role + ":" + x.p.objective)
    .join("\n");
  return [
    "总经理给你派活了。",
    "",
    "【老板的任务】\n" + task,
    "",
    "【整体架构】\n" + plan.architecture,
    "",
    "【你的职位】" + pkg.role + "(工作包 " + (i + 1) + ",共 " + packages.length + " 个工作包)",
    "【你的目标】" + pkg.objective,
    "",
    "【具体要求与验收标准】\n" + pkg.requirements,
    "",
    "【与其他工作包的衔接约定】\n" + pkg.handoff,
    "",
    "【其他同事在做什么(只用于衔接,不要替他们做)】\n" + others,
    "",
    "请把你的成果完整写入这个文件(workspace 相对路径,Markdown,自成一体:开头一段说明你完成了什么,正文是成果本身,结尾列出你的假设和未覆盖处):\n" + outPaths[i],
    "",
    "完成后返回:summary(一段话:做了什么、核心结论)、deliverablePath(你写的文件路径)、notes(总经理或同事需要知道的衔接事项、假设、未覆盖处)。",
  ].join("\n");
}
function buildReviewAsk(): string {
  const listing = packages
    .map((pkg, i) => {
      const r = workerResults[i];
      const path = r ? r.deliverablePath : "(员工未返回路径)";
      const summary = r ? r.summary : "(无)";
      const notes = r ? r.notes : "(无)";
      return "【工作包" + (i + 1) + "·" + pkg.role + "】\n成果文件:" + path + "\n员工自述:" + summary + "\n衔接说明:" + notes;
    })
    .join("\n\n");
  return [
    "员工已交回全部 " + packages.length + " 个工作包的成果。请你逐一验收——你的职责是找出问题,不是给人情分。",
    "",
    listing,
    "",
    "请逐个打开上面的成果文件,对照你派活时的要求验收;再检查各包拼在一起能否完整覆盖老板的任务、接口是否对得上、有没有互相矛盾。宁可打回,也不要放过明显缺陷。",
    "返回 Review:verdicts 每个工作包一条(packageNo 从 1 开始;pass 表示是否通过;feedback 不通过时写明具体问题与修改要求,通过时一句话认可),integrationIssues 写跨包衔接问题,没有则留空字符串。",
  ].join("\n");
}
function buildReReviewAsk(failing: number[]): string {
  const names = failing.map(packageLabel).join("、");
  const listing = failing
    .map((no) => {
      const r = workerResults[no - 1];
      const path = r ? r.deliverablePath : "(未返回路径)";
      const summary = r ? r.summary : "(无)";
      return "【" + packageLabel(no) + "】\n成果文件:" + path + "\n返工后自述:" + summary;
    })
    .join("\n\n");
  return [
    "以下工作包已按你的意见返工,请重新打开成果文件验收:" + names + "。",
    "",
    listing,
    "",
    "返回 Review:verdicts 只需覆盖上面这些包(packageNo 从 1 开始,pass、feedback 同前);integrationIssues 填最新的跨包衔接情况,没有则留空字符串。",
  ].join("\n");
}
function buildReworkAsk(no: number): string {
  const v = verdictByNo[no - 1];
  const feedback = v
    ? v.feedback
    : "总经理没有给出具体意见,请对照派活时的要求自查并补强成果。";
  const integration =
    integrationIssues.length > 0
      ? "\n【跨包衔接问题(与你有关的要一并修正)】\n" + integrationIssues
      : "";
  return [
    "总经理验收后,你的工作包被打回返工。",
    "",
    "【审核意见】\n" + feedback + integration,
    "",
    "请按意见修改你的成果文件(直接覆盖更新):" + outPaths[no - 1],
    "改完后返回:summary(改了什么、现在的结论)、deliverablePath、notes。",
  ].join("\n");
}
function buildFinalAsk(stillFailing: number[]): string {
  const statusLines = packages
    .map((pkg, i) => {
      const v = verdictByNo[i];
      const state = v && v.pass ? "已通过验收" : "未完全达标";
      return (i + 1) + ". " + pkg.role + ":" + state;
    })
    .join("\n");
  const warn =
    stillFailing.length > 0
      ? "\n注意:工作包 " + stillFailing.join("、") + " 在返工轮次上限内仍未完全通过你的验收。交付报告中必须如实向老板说明这部分的状态与风险,不要粉饰。"
      : "";
  return [
    "所有工作包已完成审核,现在由你汇总,向老板做最终交付。",
    "",
    "【各工作包验收状态】\n" + statusLines + warn,
    "",
    "请写一份完整的交付报告(Markdown),老板会直接阅读:",
    "1. 开头两三句话:老板的任务完成得怎么样,整体结论;",
    "2. 整体架构与分工回顾(简短);",
    "3. 各部分成果:每部分是什么、核心内容、成果文件在哪(引用文件路径,老板可以点开细看);",
    "4. 遗留问题、风险与建议(如有)。",
    "",
    "返回:conclusion(两三句总结)、reportMarkdown(报告全文)、openIssues(需要老板知晓或拍板的事项,没有则空数组)。",
  ].join("\n");
}
function buildReaderAsk(d: FinalDelivery): string {
  const fileList = packages
    .map((_pkg, i) => {
      const r = workerResults[i];
      return "- " + packageLabel(i + 1) + ":" + (r ? r.deliverablePath : "(无)");
    })
    .join("\n");
  return [
    "下面是一份AI团队写给老板的最终交付报告,以及各部分成果文件的路径。你从没参与这个项目,请以挑剔的独立视角审读:",
    "1. 通读报告全文,挑出:写得不清楚的地方、前后矛盾的、结论没有依据的;",
    "2. 抽查上面列出的成果文件,核对报告里的说法与成果是否一致;",
    "3. 站在老板角度:读完这份报告,最可能追问什么?",
    "",
    "【成果文件清单】\n" + fileList,
    "",
    "【报告全文】\n" + d.reportMarkdown,
    "",
    "返回 ReaderReport:issues 列出发现的问题(每条一句话,写清位置和问题);确无问题则返回空数组,不要凑数。",
  ].join("\n");
}
function buildRevisionAsk(issues: string[]): string {
  const lines = issues.map((s, i) => (i + 1) + ". " + s).join("\n");
  return [
    "一位从没参与项目的独立审读员,以老板的视角读了你的交付报告,提出以下意见:",
    "",
    lines,
    "",
    "请逐条处理:意见合理的,修订报告;意见不合理的,也请把相关表述写得更清楚,让老板不会误解。返回修订后的完整 FinalDelivery(reportMarkdown 为重写后的全文;conclusion、openIssues 一并给出)。",
  ].join("\n");
}
function absorb(rv: Review): void {
  for (const v of rv.verdicts) {
    if (v.packageNo >= 1 && v.packageNo <= packages.length) {
      verdictByNo[v.packageNo - 1] = v;
    }
  }
  if (rv.integrationIssues.length > 0) {
    integrationIssues = rv.integrationIssues;
  }
}
function failingNos(): number[] {
  const nos: number[] = [];
  for (let i = 0; i < packages.length; i++) {
    const v = verdictByNo[i];
    if (!v || !v.pass) nos.push(i + 1);
  }
  return nos;
}
function reportVerdicts(rv: Review): void {
  for (const v of rv.verdicts) {
    if (v.packageNo < 1 || v.packageNo > packages.length) continue;
    report(
      {
        packageNo: v.packageNo,
        role: packages[v.packageNo - 1].role,
        status: v.pass ? "已通过" : "返工中",
        note: v.feedback,
      },
      "progress",
    );
  }
}

for (let i = 0; i < packages.length; i++) {
  report({ packageNo: i + 1, role: packages[i].role, status: "执行中", note: packages[i].objective }, "progress");
}
log("总经理把任务拆成了 " + packages.length + " 个工作包:" + packages.map((p) => p.role).join("、"));

phase("员工并行完成各自工作包");
const settled = await Promise.all( // 总经理要对照全部成果做整体审核,这里必须等所有包交齐
  workers.map((w, i) => w.ask<WorkerResult>(buildWorkerAsk(i))),
);
for (let i = 0; i < settled.length; i++) {
  workerResults[i] = settled[i];
  report({ packageNo: i + 1, role: packages[i].role, status: "待审核", note: settled[i].summary }, "progress");
}

phase("总经理审核各组成果");
log("全部成果已交回,总经理逐一验收");
const firstReview = await gm.ask<Review>(buildReviewAsk());
absorb(firstReview);
reportVerdicts(firstReview);

for (let round = 1; round <= maxRounds; round++) {
  const failing = failingNos();
  if (failing.length === 0) break;
  const names = failing.map(packageLabel).join("、");
  log("第 " + round + " 轮返工:" + names + "被打回");

  phase("员工按审核意见返工");
  const reworked = await Promise.all(
    failing.map((no) => workers[no - 1].ask<WorkerResult>(buildReworkAsk(no))),
  );
  for (let k = 0; k < failing.length; k++) {
    workerResults[failing[k] - 1] = reworked[k];
    report(
      { packageNo: failing[k], role: packages[failing[k] - 1].role, status: "待审核", note: "已按总经理意见返工,等待复审" },
      "progress",
    );
  }

  phase("总经理复审返工成果");
  const reReview = await gm.ask<Review>(buildReReviewAsk(failing));
  absorb(reReview);
  reportVerdicts(reReview);
}

for (const no of failingNos()) {
  report(
    { packageNo: no, role: packages[no - 1].role, status: "未达标", note: "在返工轮次上限内仍未通过审核" },
    "progress",
  );
}

phase("总经理汇总交付老板");
const stillFailing = failingNos();
log(
  stillFailing.length === 0
    ? "全部工作包验收通过,总经理开始汇总交付"
    : stillFailing.length + " 个工作包未完全达标,总经理将如实向老板说明",
);
let delivered = await gm.ask<FinalDelivery>(buildFinalAsk(stillFailing));

phase("换一双眼睛审读交付报告");
const reader = agent("独立审读员", { system: READER_PERSONA });
const read = await reader.ask<ReaderReport>(buildReaderAsk(delivered));
if (read.issues.length > 0) {
  log("审读员提出 " + read.issues.length + " 条意见,总经理正在修订报告");
  phase("总经理按审读意见修订报告");
  delivered = await gm.ask<FinalDelivery>(buildRevisionAsk(read.issues));
} else {
  log("审读员一次通过,报告直接交付");
}

await artifact.markdown("final-report", delivered.reportMarkdown, {
  title: "总经理交付报告",
  description: "总经理审核把关、独立审读员复核后的最终交付,含各部分成果、文件位置与遗留问题。",
  primary: true,
});

return {
  conclusion: delivered.conclusion,
  packages: packages.map((pkg, i) => {
    const r = workerResults[i];
    const v = verdictByNo[i];
    return {
      no: i + 1,
      role: pkg.role,
      status: v && v.pass ? "通过" : "未完全达标",
      summary: r ? r.summary : "(无)",
      file: r ? r.deliverablePath : "(无)",
    };
  }),
  openIssues: delivered.openIssues,
  verified: [
    "总经理对每个工作包的成果文件逐个打开验收;未通过的打回返工,直至通过或到达返工轮次上限",
    "交付报告经未参与项目的独立审读员冷读把关,其意见已由总经理逐条处理",
  ],
  notCovered: [
    "没有任务无关的自动化校验(编译、测试等)——是否需要取决于具体任务,由员工完成时自行验证、总经理审核时把关",
    "审读员对成果文件的核对是抽查性质,不是对所有事实的逐字校验",
  ],
};
