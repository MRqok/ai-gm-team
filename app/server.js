// 总经理团队 · 独立版 服务端
// 零依赖:仅使用 Node 内置模块(node >= 18)。启动后浏览器访问 http://127.0.0.1:8787
// 架构:老板下达任务 → 总经理拆解分工 → 员工并行执行 → 总经理逐包审核/打回返工 → 独立审读员把关 → 汇总交付报告
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8787;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUTPUT_DIR = path.join(ROOT, '成果');

const runs = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rid() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function sanitizeName(s) { return String(s || '').replace(/[\\/:*?"<>|\s.]/g, '').slice(0, 40) || '任务'; }

// ---------------- 人设(与开源工作流 v2.0 保持一致) ----------------
const GM_SYS = '你是一位经验丰富、对结果负责的总经理,直接向老板(用户)汇报。老板把任务全权交给你,你的职责是:吃透任务并设计整体架构;把任务拆成边界清晰、可并行、最后拼得起来的工作包,派给职位合适的员工;员工交回成果后,你以挑剔的标准逐包验收,宁可打回返工也不放过明显缺陷;全部合格(或到达轮次上限)后,由你亲自汇总成交付报告呈给老板。你汇报时要诚实:做得好的、有欠缺的、没验证的,分开说清楚。如果发现任务本身有矛盾或说不通,如实说明,不要硬做。全程用中文。';
const WORKER_SYS = '你是一名能干、靠谱的员工,只负责总经理分派给你的那一个工作包。你没有文件工具,所有成果都直接写在回复的 JSON 里。把成果整理成一份完整、自成一体、拿来就能用的 Markdown 文档;涉及事实性内容时,如实标注信息来源或注明是估计。如果发现任务说不通或超出你的能力,如实说明,不要编造。全程用中文。';
const READER_SYS = '你是一位挑剔的独立审读员,从没参与过这个项目,以一个忙碌老板的视角工作。你会拿到一份AI团队写给老板的交付报告和各部分成果摘要;你的任务是只凭阅读挑毛病:哪些结论没有依据、哪些地方写得不清楚或前后矛盾、老板读完最可能追问什么。发现问题就如实列出;确实没有问题就返回空数组,不要为了凑数硬挑。全程用中文。';

// ---------------- LLM 调用(OpenAI 兼容 /chat/completions) ----------------
function extractJson(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

async function chat(cfg, messages, opts = {}) {
  const json = opts.json !== false;
  const maxTokens = opts.maxTokens || 6000;
  const url = cfg.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const body = { model: cfg.model, messages, temperature: 0.4, max_tokens: maxTokens, stream: false };
  if (json) body.response_format = { type: 'json_object' };
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(body),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(180000) : undefined,
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error('接口返回 HTTP ' + res.status + ':' + t.slice(0, 300));
      }
      const data = await res.json();
      const choice = data.choices && data.choices[0];
      const content = choice && choice.message && choice.message.content || '';
      if (!content) throw new Error('接口返回了空内容');
      if (json) return extractJson(content);
      return content;
    } catch (e) {
      lastErr = e;
      if (json && e instanceof SyntaxError) {
        messages = messages.concat([{ role: 'user', content: '你上一次的输出无法解析为 JSON。请重新输出:只输出一个合法的 JSON 对象,不要包含任何解释文字或代码块标记。' }]);
      }
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  throw lastErr || new Error('LLM 调用失败');
}

// ---------------- 提示词 ----------------
function planPrompt(task, maxW) {
  return [
    '老板把下面这个任务全权交给了你:', '', task, '',
    '请拿出整体方案与分工:',
    '1. architecture:先吃透任务,给出整体架构——怎么理解、分几块、为什么这样分、各块最后如何拼装(300字以内);',
    '2. outputDir:给这次任务的成果起一个简短的中文目录名;',
    '3. packages:拆成 2-' + maxW + ' 个工作包,每个包有明确的职位名、目标、要求与验收标准、衔接约定;边界要清晰,能并行推进,合起来恰好覆盖整个任务。',
    '',
    '返回 JSON:{"architecture":"...","outputDir":"...","packages":[{"role":"职位名","objective":"目标","requirements":"要求与验收标准","handoff":"衔接约定"}]}',
  ].join('\n');
}
function workerPrompt(p) {
  const others = p.all.map((x, j) => (j === p.idx ? null : (j + 1) + '. ' + x.role + ':' + x.objective)).filter(Boolean).join('\n');
  return [
    '总经理给你派活了。', '',
    '【老板的任务】\n' + p.task, '',
    '【整体架构】\n' + p.architecture, '',
    '【你的职位】' + p.pkg.role + '(工作包 ' + p.no + ',共 ' + p.total + ' 个工作包)',
    '【你的目标】' + p.pkg.objective, '',
    '【具体要求与验收标准】\n' + p.pkg.requirements, '',
    '【与其他工作包的衔接约定】\n' + p.pkg.handoff, '',
    '【其他同事在做什么(只用于衔接,不要替他们做)】\n' + others, '',
    p.feedback ? ('【总经理的返工意见(请按意见修改成果)】\n' + p.feedback + (p.integration ? '\n【跨包衔接问题(与你有关的一并修正)】\n' + p.integration : '')) + '\n' : '',
    '请把你的成果写成一份完整的 Markdown 文档(自成一体:开头说明完成了什么,正文是成果本身,结尾列出假设与未覆盖处)。',
    '返回 JSON:{"summary":"150字以内:做了什么、核心结论","content":"成果文档完整 Markdown","notes":"100字以内:衔接事项、假设、未覆盖处,没有则写无"}',
  ].filter((s) => s !== '').join('\n');
}
function reviewPrompt(p) {
  const listing = p.items.map((it) =>
    '【工作包' + it.no + '·' + it.role + '】\n员工自述:' + it.summary + '\n成果全文:\n' + String(it.content || '').slice(0, 6000)
  ).join('\n\n');
  return [
    '员工已交回全部 ' + p.items.length + ' 个工作包的成果。请你逐一验收——你的职责是找出问题,不是给人情分。', '',
    listing, '',
    '请验收:对照你派活时的要求检查每份成果;再检查各包拼在一起能否完整覆盖老板的任务、接口是否对得上、有没有互相矛盾。宁可打回,也不要放过明显缺陷。',
    '返回 JSON:{"verdicts":[{"packageNo":1,"pass":true,"feedback":"不通过时写明具体问题与修改要求;通过时一句话认可"}],"integrationIssues":"跨包衔接问题,没有则空字符串"}',
  ].join('\n');
}
function readerPrompt(p) {
  const samples = p.samples.map((s) => '- ' + s.role + ':' + s.summary + '\n  成果节选:' + String(s.sample || '').replace(/\s+/g, ' ').slice(0, 400)).join('\n');
  return [
    '下面是一份AI团队写给老板的交付报告,以及各部分成果的摘要。你从没参与这个项目,请以挑剔的独立视角审读:', '',
    '【报告全文】\n' + p.report, '',
    '【各部分成果摘要】\n' + samples, '',
    '只挑真问题:结论没有依据的、写得不清楚或前后矛盾的、老板读完最可能追问的。返回 JSON:{"issues":["问题1","问题2"]},确无问题返回空数组。',
  ].join('\n');
}
function finalPrompt(p) {
  const statusLines = p.statuses.map((s) => s.no + '. ' + s.role + ':' + (s.pass ? '已通过验收' : '未完全达标')).join('\n');
  const warn = p.failingNos.length ? '\n注意:工作包 ' + p.failingNos.join('、') + ' 在返工轮次上限内仍未完全通过你的验收。交付报告中必须如实向老板说明这部分的状态与风险,不要粉饰。' : '';
  return [
    '所有工作包已完成审核,现在由你汇总,向老板做最终交付。', '',
    '【老板的任务】\n' + p.task, '',
    '【各工作包验收状态】\n' + statusLines + warn, '',
    '请写一份完整的交付报告(Markdown),老板会直接阅读:',
    '1. 开头两三句话:任务完成得怎么样,整体结论;',
    '2. 整体架构与分工回顾(简短);',
    '3. 各部分成果:每部分是什么、核心内容(引用工作包文件名:' + p.statuses.map((s) => s.fileName).join('、') + ');',
    '4. 遗留问题、风险与建议(如有)。',
    '',
    '返回 JSON:{"conclusion":"两三句总结","reportMarkdown":"报告全文","openIssues":["需要老板知晓或拍板的事项,没有则空数组"]}',
  ].join('\n');
}
function revisePrompt(p) {
  return [
    '一位从没参与项目的独立审读员,以老板的视角读了你的交付报告,提出以下意见:', '',
    p.issues.map((s, i) => (i + 1) + '. ' + s).join('\n'), '',
    '请逐条处理:意见合理的,修订报告;意见不合理的,也把相关表述写得更清楚。返回修订后的完整 JSON:{"conclusion":"...","reportMarkdown":"修订后报告全文","openIssues":[...]}',
  ].join('\n');
}

// ---------------- 真实 LLM ----------------
function makeRealLLM(cfg) {
  const gm = (p, o) => chat(cfg, [{ role: 'system', content: GM_SYS }, { role: 'user', content: p }], o);
  return {
    async plan(x) { return gm(planPrompt(x.task, x.maxW), { maxTokens: 3000 }); },
    async worker(x) { return chat(cfg, [{ role: 'system', content: WORKER_SYS }, { role: 'user', content: workerPrompt(x) }], { maxTokens: 8000 }); },
    async review(x) { return gm(reviewPrompt(x), { maxTokens: 3000 }); },
    async reader(x) { return chat(cfg, [{ role: 'system', content: READER_SYS }, { role: 'user', content: readerPrompt(x) }], { maxTokens: 2000 }); },
    async final(x) { return gm(finalPrompt(x), { maxTokens: 8000 }); },
    async revise(x) { return gm(revisePrompt(x), { maxTokens: 8000 }); },
  };
}

// ---------------- 演示模式(不需要 API Key,内容为拟真占位) ----------------
function makeMockLLM() {
  return {
    async plan(x) {
      await sleep(1200);
      const t = x.task.slice(0, 60);
      return {
        architecture: '针对「' + t + '」,采用三路并行的作战方案:调研员摸清背景与现状,策划师产出方案主体,分析师用数据口径校验结论;最后由总经理统一拼装成完整交付物。(演示模式)',
        outputDir: '演示任务',
        packages: [
          { role: '市场调研员', objective: '搜集并整理任务相关的背景、现状与主要参考信息', requirements: '覆盖基本盘、主要做法、可引用的公开事实;示意数据需标注', handoff: '输出调研要点,供策划师引用' },
          { role: '方案策划师', objective: '产出任务主体方案与落地步骤', requirements: '结构完整、步骤可执行、含时间表与分工建议', handoff: '引用调研要点,输出方案主体' },
          { role: '数据分析师', objective: '为方案提供数据口径与校验', requirements: '给出关键指标定义与示意数据,指出数据局限', handoff: '输出数据附件,供总经理引用' },
        ],
      };
    },
    async worker(x) {
      await sleep(1000 + Math.random() * 1200);
      const tag = x.feedback ? '(已按意见返工)' : '(演示模式生成)';
      return {
        summary: '已完成「' + x.pkg.objective.slice(0, 30) + '」,产出结构化成果' + tag + '。',
        content: '# ' + x.pkg.role + ' · 工作成果 ' + tag + '\n\n> 老板的任务:' + x.task + '\n\n## 一、完成内容\n\n本部分为演示模式的占位成果:配置 API Key 后,这里将由真实大模型生成完整内容。\n\n## 二、落地排期与分工\n\n- 第 1 周:完成' + x.pkg.objective.slice(0, 12) + '相关的准备工作\n- 第 2 周:产出初稿并交叉评审\n- 第 3 周:定稿并交付总经理拼装\n\n## 三、核心结论\n\n1. ' + x.pkg.objective + '已按要求完成;\n2. 与其他工作包的衔接点:' + x.pkg.handoff + ';\n3. 关键假设:演示数据仅供参考。\n\n## 四、假设与未覆盖\n\n- 演示模式:所有内容为拟真占位,不代表真实调研结果。\n',
        notes: '演示模式:内容为占位样例。',
      };
    },
    async review(x) {
      await sleep(1400);
      if (x.round === 0) {
        return {
          verdicts: x.items.map((it) => ({ packageNo: it.no, pass: it.no !== 2, feedback: it.no === 2 ? '方案缺少可执行的时间表与分工建议,请补充一节「落地排期与分工」,并说明各周交付物。' : '结构完整、覆盖到位,通过。' })),
          integrationIssues: '',
        };
      }
      return { verdicts: x.items.map((it) => ({ packageNo: it.no, pass: true, feedback: '已按意见补充排期与分工,通过。' })), integrationIssues: '' };
    },
    async reader(x) {
      await sleep(1200);
      return { issues: ['报告「核心结论」部分有多处判断没有给出依据,建议标注来源或注明是估计。', '「遗留问题」一节没有说明后续如何验证效果,老板读完大概率会追问。'] };
    },
    async final(x) {
      await sleep(1300);
      return {
        conclusion: '任务「' + x.task.slice(0, 30) + '」已完成:共 ' + x.statuses.length + ' 个工作包,' + x.passCount + ' 个通过验收' + (x.failCount ? ',' + x.failCount + ' 个未完全达标。' : '。') + '(演示模式)',
        openIssues: x.failCount ? ['工作包 ' + x.failingNos.join('、') + ' 未完全达标,建议追加一轮返工或人工复核。'] : [],
        reportMarkdown: null, // 由编排器用统一模板生成
      };
    },
    async revise(x) {
      await sleep(1200);
      return { issuesApplied: true };
    },
  };
}

// ---------------- 编排引擎 ----------------
function emit(run, type, data) { run.events.push({ i: run.events.length, t: Date.now(), type, data: data || {} }); }
function setPhase(run, p) { run.phase = p; emit(run, 'phase', { phase: p }); }
function setWorker(run, no, patch) {
  const w = run.workers[no - 1];
  if (!w) return;
  Object.assign(w, patch);
  emit(run, 'worker', { no, role: w.role, status: w.status, summary: w.summary, feedback: w.feedback });
}
function publicWorkers(run) {
  return run.workers.map((w) => ({ no: w.no, role: w.role, objective: w.objective, status: w.status, summary: w.summary, feedback: w.feedback, file: w.file ? path.basename(w.file) : '' }));
}

async function orchestrate(run) {
  const opts = run.opts;
  const task = opts.task;
  const llm = run.mock ? makeMockLLM() : makeRealLLM(run.cfg);
  try {
    // 1. 总经理拆解
    setPhase(run, 'plan');
    emit(run, 'log', { msg: '总经理开始拆解任务…' });
    const plan = await llm.plan({ task, maxW: opts.maxWorkers });
    let packages = Array.isArray(plan.packages) ? plan.packages.slice(0, opts.maxWorkers) : [];
    if (!packages.length) packages = [{ role: '全能员工', objective: task, requirements: '完整地完成任务,成果自成一体', handoff: '无' }];
    run.architecture = plan.architecture || '';
    run.workers = packages.map((pkg, i) => ({ no: i + 1, role: String(pkg.role || ('员工' + (i + 1))), objective: String(pkg.objective || ''), requirements: String(pkg.requirements || ''), handoff: String(pkg.handoff || ''), status: '执行中', summary: '', feedback: '', file: '', content: '', notes: '' }));
    const runDir = path.join(OUTPUT_DIR, sanitizeName(plan.outputDir) + '-' + run.id);
    fs.mkdirSync(runDir, { recursive: true });
    run.dir = runDir;
    emit(run, 'plan', { architecture: run.architecture, packages: run.workers.map((w) => ({ no: w.no, role: w.role, objective: w.objective })) });
    emit(run, 'log', { msg: '拆分为 ' + run.workers.length + ' 个工作包:' + run.workers.map((w) => w.role).join('、') });

    // 2. 员工并行执行
    setPhase(run, 'work');
    await Promise.all(run.workers.map(async (w) => {
      const r = await llm.worker({ task, architecture: run.architecture, pkg: w, all: run.workers, idx: w.no - 1, no: w.no, total: run.workers.length });
      w.content = String(r.content || '');
      w.summary = String(r.summary || '');
      w.notes = String(r.notes || '');
      w.file = path.join(runDir, '工作包' + w.no + '-' + sanitizeName(w.role) + '.md');
      fs.writeFileSync(w.file, w.content, 'utf8');
      setWorker(run, w.no, { status: '待审核', summary: w.summary });
    }));
    emit(run, 'log', { msg: '全部成果已交回,总经理逐一验收' });

    // 3. 审核与返工循环
    const verdicts = new Map();
    let integrationIssues = '';
    const absorb = (rv) => {
      for (const v of (rv.verdicts || [])) if (v.packageNo >= 1 && v.packageNo <= run.workers.length) verdicts.set(v.packageNo, v);
      if (rv.integrationIssues) integrationIssues = rv.integrationIssues;
    };
    const failingNos = () => run.workers.filter((w) => { const v = verdicts.get(w.no); return !v || !v.pass; }).map((w) => w.no);
    const reviewItems = (nos) => run.workers.filter((w) => !nos || nos.includes(w.no)).map((w) => ({ no: w.no, role: w.role, summary: w.summary, content: w.content }));

    setPhase(run, 'review');
    absorb(await llm.review({ items: reviewItems(null), round: 0 }));
    for (const v of verdicts.values()) setWorker(run, v.packageNo, { status: v.pass ? '已通过' : '返工中', feedback: v.feedback });

    for (let round = 1; round <= opts.maxRounds; round++) {
      const failing = failingNos();
      if (!failing.length) break;
      emit(run, 'log', { msg: '第 ' + round + ' 轮返工:工作包 ' + failing.join('、') + ' 被打回' });
      setPhase(run, 'rework');
      await Promise.all(failing.map(async (no) => {
        const w = run.workers[no - 1];
        const v = verdicts.get(no);
        const r = await llm.worker({
          task, architecture: run.architecture, pkg: w, all: run.workers, idx: no - 1, no, total: run.workers.length,
          feedback: v ? v.feedback : '请对照派活要求自查并补强成果。',
          integration: integrationIssues,
        });
        w.content = String(r.content || w.content);
        w.summary = String(r.summary || w.summary);
        fs.writeFileSync(w.file, w.content, 'utf8');
        setWorker(run, no, { status: '待审核', summary: w.summary });
      }));
      setPhase(run, 'review');
      absorb(await llm.review({ items: reviewItems(failing), round }));
      for (const no of failing) {
        const v = verdicts.get(no);
        setWorker(run, no, { status: v && v.pass ? '已通过' : '返工中', feedback: v ? v.feedback : '' });
      }
    }

    for (const no of failingNos()) setWorker(run, no, { status: '未达标', feedback: '在返工轮次上限内仍未通过审核' });

    // 4. 汇总交付
    setPhase(run, 'report');
    const stillFailing = failingNos();
    const statuses = run.workers.map((w) => { const v = verdicts.get(w.no); return { no: w.no, role: w.role, pass: !!(v && v.pass), summary: w.summary, fileName: w.file ? path.basename(w.file) : '' }; });
    const passCount = statuses.filter((s) => s.pass).length;
    const finalInfo = { task, statuses, passCount, failCount: statuses.length - passCount, failingNos: stillFailing };
    let delivered = await llm.final(finalInfo);

    // 5. 独立审读员把关
    setPhase(run, 'audit');
    const read = await llm.reader({
      report: buildReportMarkdown(run, finalInfo, delivered),
      samples: run.workers.map((w) => ({ role: w.role, summary: w.summary, sample: w.content })),
    });
    const issues = Array.isArray(read.issues) ? read.issues : [];
    if (issues.length) {
      emit(run, 'log', { msg: '审读员提出 ' + issues.length + ' 条意见,总经理正在修订报告' });
      const revised = await llm.revise({ report: buildReportMarkdown(run, finalInfo, delivered), issues });
      if (revised && revised.reportMarkdown) delivered = revised;
      else emit(run, 'log', { msg: '总经理已按审读意见修订报告(演示模式)' });
    } else {
      emit(run, 'log', { msg: '审读员一次通过,报告直接交付' });
    }

    // 6. 落盘
    const reportMarkdown = delivered.reportMarkdown ? String(delivered.reportMarkdown) : buildReportMarkdown(run, finalInfo, { conclusion: delivered.conclusion, issuesApplied: !issues.length ? false : true });
    const reportFile = path.join(runDir, '总经理交付报告.md');
    fs.writeFileSync(reportFile, reportMarkdown, 'utf8');
    run.report = { file: reportFile, conclusion: String(delivered.conclusion || ''), openIssues: Array.isArray(delivered.openIssues) ? delivered.openIssues.map(String) : [] };
    setPhase(run, 'done');
    emit(run, 'done', { reportFile, conclusion: run.report.conclusion, openIssues: run.report.openIssues, markdown: reportMarkdown });
  } catch (e) {
    run.error = String((e && e.message) || e);
    setPhase(run, 'error');
    emit(run, 'error', { message: run.error });
  }
}

function buildReportMarkdown(run, info, delivered) {
  if (delivered && delivered.reportMarkdown) return String(delivered.reportMarkdown);
  const lines = [
    '# 总经理交付报告' + (run.mock ? '(演示模式)' : ''),
    '',
    '**任务:**' + info.task,
    '',
    '## 一、整体结论',
    '',
    delivered.conclusion || '任务已完成。',
    '',
    '## 二、整体架构与分工',
    '',
    run.architecture || '(见各工作包文件)',
    '',
    '## 三、各部分成果',
    '',
    ...info.statuses.map((s) => '- **工作包' + s.no + ' · ' + s.role + '**(' + (s.pass ? '已通过验收' : '未完全达标') + ')— ' + s.summary + ' 成果文件:`' + s.fileName + '`'),
    '',
    '## 四、遗留问题与建议',
    '',
    ...(info.failingNos.length ? ['- 工作包 ' + info.failingNos.join('、') + ' 未完全达标,建议追加返工或人工复核。'] : []),
    '- 本报告由 AI 团队生成,重要信息请自行核实。',
  ];
  return lines.join('\n');
}

// ---------------- HTTP 服务 ----------------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('JSON 解析失败')); } });
    req.on('error', reject);
  });
}
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      const task = String(body.task || '').trim();
      if (!task) return sendJson(res, 400, { error: '任务内容不能为空' });
      const mock = !!body.mock;
      const cfg = { baseURL: String(body.baseURL || '').trim(), apiKey: String(body.apiKey || '').trim(), model: String(body.model || '').trim() };
      if (!mock && (!cfg.baseURL || !cfg.apiKey || !cfg.model)) return sendJson(res, 400, { error: '真实运行需要填写 API 地址、Key 和模型;或勾选演示模式' });
      const run = {
        id: rid(), mock, cfg, opts: { task, maxWorkers: Math.min(Math.max(+body.maxWorkers || 3, 1), 6), maxRounds: Math.min(Math.max(+body.maxRounds || 2, 1), 5) },
        status: 'running', phase: 'plan', events: [], workers: [], architecture: '', report: null, error: null, startedAt: Date.now(),
      };
      runs.set(run.id, run);
      orchestrate(run); // 后台执行
      return sendJson(res, 200, { runId: run.id });
    }
    if (u.pathname === '/api/events') {
      const run = runs.get(u.searchParams.get('runId'));
      if (!run) return sendJson(res, 404, { error: '任务不存在' });
      const since = Math.max(0, parseInt(u.searchParams.get('since') || '0', 10) || 0);
      return sendJson(res, 200, {
        status: run.phase === 'done' ? 'done' : run.phase === 'error' ? 'error' : 'running',
        phase: run.phase, workers: publicWorkers(run),
        events: run.events.slice(since), next: run.events.length,
        report: run.report, error: run.error,
      });
    }
    if (u.pathname === '/api/runs') {
      return sendJson(res, 200, { runs: [...runs.values()].map((r) => ({ id: r.id, task: r.opts.task.slice(0, 50), mock: r.mock, phase: r.phase, startedAt: r.startedAt })) });
    }
    if (req.method === 'GET') return serveStatic(res, u.pathname);
    res.writeHead(405); res.end('Method Not Allowed');
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

if (typeof fetch !== 'function') {
  console.error('[错误] 当前 Node 版本过低(需要 >= 18,内置 fetch)。');
  process.exit(1);
}
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
server.listen(PORT, HOST, () => {
  console.log('总经理团队 · 独立版 已启动: http://127.0.0.1:' + PORT);
  console.log('按 Ctrl+C 停止服务。');
});
