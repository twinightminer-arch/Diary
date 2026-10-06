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
