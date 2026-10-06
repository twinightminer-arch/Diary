// SPDX-License-Identifier: AGPL-3.0-only
export type CampusProfile = {
  name: string; studentId: string; school: string; college: string;
  major: string; grade: string; phone: string; email: string;
};

export type CampusService = {
  id: string; icon: string; title: string; description: string; department: string;
  fields: string[]; materials: string[]; steps: string[]; keywords: string[];
};

export type CampusCase = {
  id: string; serviceId: string; title: string; department: string;
  createdAt: string; status: 'draft' | 'submitted' | 'processing' | 'completed';
  fields: Record<string, string>; materials: { name: string; checked: boolean }[];
  steps: { label: string; department: string; done: boolean }[];
};

export const campusServices: CampusService[] = [
  { id: 'leave', icon: '🗓', title: '请假申请', description: '事假、病假与离校报备', department: '辅导员 / 学工处', fields: ['请假类型', '开始时间', '结束时间', '请假原因'], materials: ['请假申请表', '相关证明（如有）'], steps: ['辅导员审核', '学院复核', '学工处备案'], keywords: ['请假', '病假', '事假', '离校'] },
  { id: 'scholarship', icon: '🏅', title: '奖助学金', description: '奖学金、助学金与家庭经济认定', department: '学院 / 资助中心', fields: ['申请项目', '学年成绩', '申请理由'], materials: ['申请表', '成绩单', '获奖证明', '家庭经济材料（助学金）'], steps: ['学院初审', '民主评议', '资助中心复核', '公示与发放'], keywords: ['奖学金', '助学金', '资助', '困难认定'] },
  { id: 'repair', icon: '🛠', title: '宿舍报修', description: '水电、门窗、家具与网络故障', department: '宿管中心 / 后勤处', fields: ['楼栋房间', '故障类型', '故障描述', '方便上门时间'], materials: ['现场照片（建议）'], steps: ['宿管受理', '后勤派单', '维修人员处理', '学生确认'], keywords: ['报修', '宿舍', '水电', '门窗', '网络'] },
  { id: 'transfer', icon: '🧭', title: '转专业', description: '申请条件检查与转专业流程', department: '原学院 / 接收学院 / 教务处', fields: ['目标学院', '目标专业', '平均绩点', '申请理由'], materials: ['转专业申请表', '成绩单', '个人陈述'], steps: ['原学院意见', '接收学院考核', '教务处审批', '学籍变更'], keywords: ['转专业', '转系', '换专业'] },
  { id: 'transcript', icon: '📜', title: '成绩证明', description: '中英文成绩单与在读证明', department: '教务处 / 档案馆', fields: ['证明类型', '语言', '份数', '用途'], materials: ['学生证或身份证', '缴费凭证（如需）'], steps: ['身份核验', '教务处出具', '盖章', '自取或邮寄'], keywords: ['成绩单', '成绩证明', '在读证明', '中英文'] },
  { id: 'internship', icon: '💼', title: '实习手续', description: '校外实习备案、保险与实习证明', department: '学院 / 就业中心', fields: ['实习单位', '岗位', '开始日期', '结束日期'], materials: ['实习协议', '家长知情书（如需）', '保险证明'], steps: ['导师确认', '学院备案', '就业中心登记', '实习结束鉴定'], keywords: ['实习', '实习协议', '实习证明'] },
];

const departmentForStep = (service: CampusService, index: number) => service.department.split(' / ')[Math.min(index, service.department.split(' / ').length - 1)]!;

export function matchCampusService(query: string): CampusService[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return campusServices;
  return campusServices.filter(service => [service.title, service.description, service.department, ...service.keywords].some(value => value.toLocaleLowerCase().includes(normalized) || normalized.includes(value.toLocaleLowerCase())));
}

export function createCampusCase(service: CampusService, profile: CampusProfile, values: Record<string, string>): CampusCase {
  const identity = { '姓名': profile.name, '学号': profile.studentId, '学校': profile.school, '学院': profile.college, '专业': profile.major, '年级': profile.grade, '手机': profile.phone, '邮箱': profile.email };
  return {
    id: crypto.randomUUID(), serviceId: service.id, title: service.title, department: service.department,
    createdAt: new Date().toISOString(), status: 'draft', fields: { ...identity, ...values },
    materials: service.materials.map(name => ({ name, checked: false })),
    steps: service.steps.map((label, index) => ({ label, department: departmentForStep(service, index), done: false })),
  };
}

export function advanceCampusCase(item: CampusCase): CampusCase {
  const steps = item.steps.map(step => ({ ...step }));
  const next = steps.find(step => !step.done);
  if (next) next.done = true;
  const completed = steps.every(step => step.done);
  const started = steps.some(step => step.done);
  return { ...item, steps, status: completed ? 'completed' : started ? 'processing' : 'submitted' };
}

export function applicationText(item: CampusCase): string {
  const body = Object.entries(item.fields).filter(([, value]) => value.trim()).map(([key, value]) => `${key}：${value}`).join('\n');
  const materials = item.materials.map(value => `- [${value.checked ? 'x' : ' '}] ${value.name}`).join('\n');
  const route = item.steps.map((value, index) => `${index + 1}. ${value.department}：${value.label}`).join('\n');
  return `# ${item.title}\n\n${body}\n\n## 材料清单\n${materials}\n\n## 办理流程\n${route}`;
}

// ---------- One-stop campus guide catalog ----------
// The merged 一办通 app exposed six top-level "办事指南" categories. Each one is
// now a real, click-through catalogue: category -> affair -> generated
// application form + material checklist + cross-department route tracking.
export type GuideCategory = { id: string; icon: string; title: string; summary: string; items: CampusService[] };

/** [id, title, description, department, fields, materials, steps] — pipe separated. */
type GuideTuple = [string, string, string, string, string, string, string];
type GuideCategoryTuple = [string, string, string, string, GuideTuple[]];

const guideRaw: GuideCategoryTuple[] = [
  ['teaching', '📘', '教学事务', '选课退课 · 考试安排 · 缓考补考 · 成绩复核', [
    ['teaching-course', '选课与退课', '选课、退课与课表确认', '教务处 / 学院教务办', '课程名称|课程代码|选课学期', '学生证|选课单', '登录教务系统选课|提交退课申请|确认个人课表|异常情况联系教务处'],
    ['teaching-exam', '考试安排查询', '考试时间、考场与准考证', '教务处 / 开课学院', '课程名称|考试时间|考场', '学生证（或身份证）', '教务系统查询考试安排|核对时间与考场|携带证件参加考试|缺考需及时报备'],
    ['teaching-defer', '缓考与补考', '因病或因事无法参加考试的补救流程', '教务处 / 任课教师', '课程名称|缓考原因|证明材料', '缓考申请表|医院证明或相关材料', '向任课教师说明情况|学院审核签字|教务处备案|按安排参加补考'],
    ['teaching-review', '成绩复核', '对成绩有异议时的复核申请', '教务处 / 开课学院', '课程名称|学期|复核理由', '成绩复核申请表|学生证', '提交复核申请|开课学院核对评分|教务处确认|结果反馈学生'],
  ]],
  ['registry', '🎓', '学籍事务', '转专业 · 休学复学 · 学位申请 · 毕业审核', [
    ['transfer', '转专业', '申请条件检查与转专业流程', '原学院 / 接收学院 / 教务处', '目标学院|目标专业|平均绩点|申请理由', '转专业申请表|成绩单|个人陈述', '原学院意见|接收学院考核|教务处审批|学籍变更'],
    ['registry-suspend', '休学与复学', '休学申请与复学返校手续', '教务处 / 学籍科', '休学原因|起止时间|复学时间', '休学申请表|相关证明|复学申请表', '辅导员确认|学院审核|教务处审批|学籍异动与复学登记'],
    ['registry-degree', '学位申请', '学士学位授予资格申请', '学位办 / 教务处', '申请学位|专业|预计毕业时间', '学位申请表|成绩单|毕业论文', '资格审核|论文答辩|学位评定委员会审议|授予学位'],
    ['registry-graduate', '毕业审核', '学分核查与毕业资格确认', '教务处 / 学院', '专业|年级|预计毕业时间', '毕业资格审核表|成绩单|学籍卡', '学分核查|学院初审|教务处复审|证书发放'],
  ]],
  ['student', '🤝', '学生工作', '奖助学金 · 请假销假 · 荣誉称号 · 证明办理', [
    ['scholarship', '奖助学金', '奖学金、助学金与家庭经济认定', '学院 / 资助中心', '申请项目|学年成绩|申请理由', '申请表|成绩单|获奖证明|家庭经济材料（助学金）', '学院初审|民主评议|资助中心复核|公示与发放'],
    ['leave', '请假与销假', '事假、病假与离校报备及返校销假', '辅导员 / 学工处', '请假类型|开始时间|结束时间|请假原因', '请假申请表|相关证明（如有）', '辅导员审核|学院复核|学工处备案|返校后销假'],
    ['student-honor', '荣誉称号评定', '三好学生、优秀学生干部等评选', '学工处 / 学院', '申报荣誉|学年|主要事迹', '荣誉申请表|获奖与证明材料', '个人申报|学院推荐|学工处评审|公示与表彰'],
    ['student-cert', '各类证明办理', '在读证明、学籍证明与在读期间证明', '学工处 / 学院', '证明类型|份数|用途', '证明申请表|学生证', '提交申请|学院审核盖章|学工处出具|自取或邮寄'],
  ]],
  ['housing', '🏠', '住宿生活', '宿舍报修 · 调宿 · 门禁 · 校园卡', [
    ['repair', '宿舍报修', '水电、门窗、家具与网络故障', '宿管中心 / 后勤处', '楼栋房间|故障类型|故障描述|方便上门时间', '现场照片（建议）', '宿管受理|后勤派单|维修人员处理|学生确认'],
    ['housing-move', '调宿申请', '更换宿舍与床位调整', '宿管中心 / 后勤处', '现住楼栋|希望调往|调宿原因', '调宿申请表|双方同意书（互换时）', '提交调宿申请|宿管协调房源|后勤审批|搬迁与登记'],
    ['housing-access', '门禁与出入', '门禁权限、访客与假期出入申请', '保卫处 / 宿管中心', '申请事项|起止时间|进出区域', '学生证|门禁卡', '提交申请|辅导员确认|保卫处审核|开通相关权限'],
    ['housing-card', '校园卡办理', '校园卡申领、补办与功能开通', '一卡通中心', '办理类型|卡号|联系方式', '身份证或学生证|一寸照片（部分情况）', '填写申请表|现场拍照采集|制卡|激活与充值'],
  ]],
  ['career', '💼', '实习就业', '实习手续 · 就业协议 · 档案户口 · 升学', [
    ['internship', '实习手续', '校外实习备案、保险与实习证明', '学院 / 就业中心', '实习单位|岗位|开始日期|结束日期', '实习协议|家长知情书（如需）|保险证明', '导师确认|学院备案|就业中心登记|实习结束鉴定'],
    ['career-agreement', '就业协议签订', '三方协议领取、盖章与备案', '就业中心 / 学院', '用人单位|岗位|签约时间', '就业协议书|单位接收函', '领取三方协议|用人单位盖章|学院盖章|就业中心备案'],
    ['career-file', '档案与户口', '档案转递、户口迁移与报到证', '就业中心 / 档案馆', '毕业去向|接收单位|档案地址', '档案转递申请|报到证|身份证', '确认毕业去向|提交转递申请|档案寄出|跟踪到档情况'],
    ['career-postgrad', '升学与推免', '推免资格、报考与复试准备', '研招办 / 学院', '报考院校|专业方向|考试类型', '推免申请表|成绩单|科研与获奖材料', '资格审核|综合排名公示|复试与考核|拟录取公示'],
  ]],
  ['public', '🏛', '公共服务', '图书馆 · 实验室 · 校医院 · 校历', [
    ['public-library', '图书馆服务', '借阅、续借、馆际互借与自习预约', '图书馆', '服务类型|书名或编号|使用时间', '校园卡', '刷卡入馆|检索并借阅|线上续借|逾期处理'],
    ['public-lab', '实验室使用', '实验室预约、安全准入与设备使用', '实验室管理处 / 学院', '实验室名称|使用时段|使用用途', '实验室使用申请|安全承诺书', '提交使用申请|导师签字同意|管理处审批|预约并登记使用'],
    ['public-hospital', '校医院就诊', '挂号、就诊、转诊与费用报销', '校医院', '就诊科室|症状描述|就诊时间', '校园卡|医保凭证', '挂号分诊|医生就诊|取药或转诊|费用报销'],
    ['public-calendar', '校历与放假安排', '学期安排、节假日与调课通知', '教务处', '学年学期|关注事项', '无', '查阅官方校历|确认节假日与调课|合理安排行程|以学校通知为准'],
  ]],
];

const knownServices = new Map(campusServices.map(service => [service.id, service]));

function toGuideService(icon: string, tuple: GuideTuple): CampusService {
  const known = knownServices.get(tuple[0]);
  if (known) return known;
  return {
    id: tuple[0], icon, title: tuple[1], description: tuple[2], department: tuple[3],
    fields: tuple[4].split('|'), materials: tuple[5].split('|'), steps: tuple[6].split('|'),
    keywords: [tuple[1]],
  };
}

export const guideCategories: GuideCategory[] = guideRaw.map(([id, icon, title, summary, items]) => ({
  id, icon, title, summary, items: items.map(tuple => toGuideService(icon, tuple)),
}));

export const guideItems: CampusService[] = guideCategories.flatMap(category => category.items);

/** Free-text lookup across the full guide catalogue (24 affairs). */
export function searchGuide(query: string): { category: GuideCategory; item: CampusService }[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  const hits: { category: GuideCategory; item: CampusService }[] = [];
  for (const category of guideCategories) {
    for (const item of category.items) {
      const haystack = [item.title, item.description, item.department, category.title, ...item.keywords].map(value => value.toLocaleLowerCase());
      if (haystack.some(value => value.includes(normalized) || normalized.includes(value))) hits.push({ category, item });
    }
  }
  return hits;
}

/**
 * Best-effort lookup for the offline answer path. Chinese questions have no
 * spaces, so a whole-sentence `includes` never matches. Every affair is scored
 * by the longest fragment of the question it contains, weighted by where that
 * fragment hit: a match in the title is a real signal, a two-character match
 * buried in a step description is usually noise ("考需" lives inside
 * "缺考需及时报备" and must not outrank 缓考与补考).
 */
export function answerFromGuide(query: string): { category: GuideCategory; item: CampusService; score: number }[] {
  const clean = query.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLocaleLowerCase();
  if (clean.length < 2) return [];
  const longest = (haystack: string): number => {
    for (let size = Math.min(6, clean.length); size >= 2; size--) {
      for (let start = 0; start + size <= clean.length; start++) {
        if (haystack.includes(clean.slice(start, start + size))) return size;
      }
    }
    return 0;
  };
  const scored: { category: GuideCategory; item: CampusService; score: number }[] = [];
  for (const category of guideCategories) {
    for (const item of category.items) {
      const heading = longest(`${item.title} ${item.keywords.join(' ')}`.toLocaleLowerCase());
      const body = longest(`${item.description} ${item.department} ${category.title}`.toLocaleLowerCase());
      const detail = longest(`${item.materials.join(' ')} ${item.steps.join(' ')}`.toLocaleLowerCase());
      const score = heading * 100 + body * 10 + detail;
      if (score > 0) scored.push({ category, item, score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 3);
}
