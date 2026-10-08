// SPDX-License-Identifier: AGPL-3.0-only
import type { TutorialStep } from './types.ts';

export const TUTORIAL_VERSION = 5;
export const moduleNames = { welcome: '开始使用', workspace: '工作台', diary: '日记', ai: 'AI 工具', campus: '校园服务', 'campus-competition': '查找校园竞赛', personalize: '个性化与安全', vpn: '学校 VPN', pets: '桌面宠物' } as const;

export const tutorialSteps: readonly TutorialStep[] = [
  { id: 'welcome', module: 'welcome', title: '欢迎使用 Diary 0.1.7', body: '这是本机优先的大学生工作台。接下来会连续介绍首页、日记、AI、校园服务、学校 VPN、桌面宠物与校园竞赛查询，全部结束后统一完成；引导不会替你执行删除、提交或联网操作。' },
  { id: 'privacy-first', module: 'welcome', title: '数据默认留在本机', body: '日记、账户和媒体默认保存在当前设备。联网和定位默认关闭，重要日记请定期导出备份。', target: '.offline-pill' },
  { id: 'accounts', module: 'welcome', title: '本地账户与 Google 登录', body: '本地账户可完全离线使用；Google 登录会创建或绑定本地账户，但不会把日记同步到云端。账户密保用于找回账户密码。', target: '.user-mini' },
  { id: 'navigation', module: 'workspace', title: '主要功能都在左侧', body: '首页、AI 问答、AI 搜索、竞赛中心、办事指南和日记可以从这里切换。', target: '#primaryNav', view: 'home' },
  { id: 'home', module: 'workspace', title: '首页与快捷入口', body: '首页汇总天气、通知、最近操作和常用入口。天气需要你主动开启联网与定位许可。', target: '#homeView', view: 'home' },
  { id: 'tutorial-entry', module: 'workspace', title: '随时重新打开教程', body: '侧栏中的“新手教程”按钮会重新启动完整引导；每次都可以跳过当前模块或跳过全部。', target: '#tutorialButton' },
  { id: 'new-diary', module: 'diary', title: '新建并书写日记', body: '进入日记后点击“新建日记”，填写标题和正文。正文支持常用 Markdown。', target: '#newEntry', view: 'diary' },
  { id: 'save-preview', module: 'diary', title: '保存与预览', body: '右上角保存会写入本地；“预览”可检查标题、列表、引用、代码块与图片效果。', target: '#previewTab', view: 'diary' },
  { id: 'diary-catalog', module: 'diary', title: '折叠目录与搜索', body: '保存后的日记按标题显示在可折叠目录中，搜索框可按标题、日期和正文摘要筛选。', target: '#entries', view: 'diary' },
  { id: 'diary-menu', module: 'diary', title: '导出与删除', body: '日记右上角三点菜单提供 Markdown 导出和删除。点击菜单外区域可关闭；删除前建议先导出。', target: '#more', view: 'diary', warning: '删除不可撤销。' },
  { id: 'diary-import', module: 'diary', title: '导入已有日记', body: '侧栏底部“导入”可以读取 Markdown 日记；加密文件会先要求输入正确密码。', target: '#import', view: 'diary' },
  { id: 'diary-security', module: 'diary', title: '密码、密保与文件位置', body: '右键目录中的日记标题，可设置密码和两个密保问题、修改密码、打开储存文件夹或复制文件路径。', target: '#entries', view: 'diary', warning: '请妥善保存密码和密保答案。' },
  { id: 'diary-tools', module: 'diary', title: 'AI、日期和天气工具', body: '编辑器工具栏可使用 AI 起草/润色/续写，也能插入日期与天气；这些联网功能需要相应许可和可用模型。', target: '.document-actions', view: 'diary' },
  { id: 'batch', module: 'diary', title: '批量保护日记', body: '勾选多篇日记后可以批量加密、解密或修改密码。操作后请检查每篇状态。', target: '#entries', view: 'diary' },
  { id: 'ai-model', module: 'ai', title: '先配置 AI 模型', body: '“AI 模型”支持官方兼容接口、自定义模型和 WorkBuddy 插件。API 密钥会使用本机设备密钥加密保存。', target: '#aiModels', view: 'home' },
  { id: 'ai-chat', module: 'ai', title: 'AI 问答', body: '可以连续提问、使用推荐问题、复制回答或清空会话。重要回答请自行核验。', target: '[data-view="chat"]', view: 'chat' },
  { id: 'ai-search', module: 'ai', title: 'AI 搜索', body: '输入要查询的主题并生成整理结果。模型摘要不等于官方事实，学校政策和截止日期必须回到权威来源确认。', target: '[data-view="search-view"]', view: 'search-view' },
  { id: 'competition', module: 'campus', title: '竞赛中心', body: '按关键词、赛道和报名状态筛选竞赛，点击卡片查看简介。当前目录含示例数据，报名以官网为准。', target: '[data-view="competition"]', view: 'competition' },
  { id: 'guide', module: 'campus', title: '办事指南', body: '指南覆盖教学、学籍、学生工作、住宿、就业和公共服务，可查询材料、部门与流程。', target: '[data-view="guide"]', view: 'guide' },
  { id: 'guide-local', module: 'campus', title: '申请表与进度只保存在本机', body: '校园身份可自动带入申请表，材料勾选和进度追踪不会向学校系统自动提交。', target: '#guideView', view: 'guide' },
  { id: 'wallpaper', module: 'personalize', title: '壁纸与背景音乐', body: '设置中可导入图片、动图、视频或扫描 Wallpaper 项目，并调整适应方式、透明度、亮度、暗化、模糊与文字可读性。', target: '#settings', view: 'home' },
  { id: 'music-media', module: 'personalize', title: '音乐与日记插图', body: '背景音乐会按列表循环播放，右下角音符可暂停；日记插图媒体点击后可插入正文，删除媒体会使旧引用失效。', target: '#musicToggle' },
  { id: 'profile', module: 'personalize', title: '账户、资料与语言', body: '设置中可修改账户密码和密保、头像、昵称、签名、界面语言及隐私许可。', target: '#settings' },
  { id: 'plugins', module: 'personalize', title: '插件管理', body: '内置功能可以开关，外部 AI 插件从本地目录加载。外部插件是可执行代码，只使用可信来源。', target: '#pluginManage' },
  { id: 'theme-lock', module: 'personalize', title: '主题与立即锁定', body: '右上角切换深浅主题；离开设备前可点击侧栏“立即锁定”，返回登录界面保护本地内容。', target: '#lockNow' },
  { id: 'vpn-entry', module: 'vpn', title: '进入学校 VPN', body: '侧栏“学校 VPN”会打开应用内的学校入口目录，不会把外部网页当作 Diary 主界面。', target: '#vpnButton', view: 'vpn' },
  { id: 'vpn-find', module: 'vpn', title: '搜索和选择学校', body: '输入学校名称、简称或网址进行搜索，也可以使用下拉栏快速选择；搜索结果和下拉选择会保持联动。', target: '.vpn-toolbar', view: 'vpn' },
  { id: 'vpn-open', module: 'vpn', title: '用浏览器打开 VPN', body: '点击学校名称、网址或“打开 VPN”按钮，会在安全校验后使用系统默认浏览器打开学校入口。', target: '#vpnList', view: 'vpn' },
  { id: 'vpn-add', module: 'vpn', title: '添加一所学校', body: '在“手动导入学校”区域填写学校名称和 HTTP/HTTPS 地址，即可将自定义学校保存在本机。', target: '.vpn-add', view: 'vpn' },
  { id: 'vpn-batch', module: 'vpn', title: '批量导入学校', body: '选择 CSV 或 JSON 后先查看预览与错误项，再确认导入；完全重复的数据会自动去除。', target: '.vpn-import-actions', view: 'vpn' },
  { id: 'pet-entry', module: 'pets', title: '进入桌面宠物', body: '侧栏“桌面宠物”会打开桌宠管理页面，并显示当前启用状态。', target: '#petButton', view: 'pets' },
  { id: 'pet-preview', module: 'pets', title: '预览已安装桌宠', body: '桌宠卡片会显示预览、名称与安装状态，帮助你在启用前确认所选伙伴。', target: '#petList', view: 'pets' },
  { id: 'pet-select', module: 'pets', title: '选择或停用桌面宠物', body: '点击卡片中的“选择”启用桌宠；页面右上角可以停用，停用后动画和资源占用会立即停止。', target: '#petToggle', view: 'pets' },
  { id: 'pet-import', module: 'pets', title: '导入和删除 PetDex v2 桌宠', body: '分别选择 pet.json 与 PNG/WebP 精灵图并校验导入。用户导入的桌宠可从卡片删除，内置伙伴不会被误删。', target: '.pet-import', view: 'pets', warning: '导入前请确认素材来源和授权许可；损坏或不完整的宠物包会被拒绝。' },
  { id: 'petdex', module: 'pets', title: '从 PetDex 获取更多桌宠', body: '页面底部提供 petdex.dev/zh 外部链接。下载后回到 Diary 导入，素材版权仍归各自作者。', target: '.petdex-footer', view: 'pets' },
  { id: 'campus-competition-entry', module: 'campus-competition', title: '查找校园竞赛', body: '点击“查找校园竞赛”，从统一学校目录搜索并选择学校；Diary 会立即尝试读取该校登记的官方页面，并明确显示加载、无结果、失败或权限限制。', target: '#campusCompetitionOpen', view: 'competition' },
  { id: 'complete', module: 'personalize', title: '教程完成', body: '你已经了解 Diary 的主要功能。记得定期导出重要日记、谨慎开启联网权限，并从侧栏“新手教程”随时复习。' },
];

