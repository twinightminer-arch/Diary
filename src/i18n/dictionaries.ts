// SPDX-License-Identifier: AGPL-3.0-only
export const enUS = {
  appName: 'Diary', newEntry: 'New entry', save: 'Save', cancel: 'Cancel',
  deleteEntry: 'Delete entry', search: 'Search', settings: 'Settings',
  username: 'Username', bio: 'Bio', avatar: 'Avatar', language: 'Language',
  signInGoogle: 'Continue with Google', signInMicrosoft: 'Continue with Microsoft',
  localAccount: 'Local encrypted account', password: 'Password', pin: 'PIN',
  lock: 'Lock', unlock: 'Unlock', encrypt: 'Encrypt', decrypt: 'Decrypt',
  confirmPasscode: 'Confirm passcode', changePasscode: 'Change passcode',
  plugins: 'Plugins', skills: 'Skills', agent: 'AI agent',
  background: 'Background', music: 'Background music', weather: 'Weather',
  location: 'Location', permissionDenied: 'Permission denied',
  entrySaved: 'Saved {title}', entryCount: 'Entries: {count}',
} as const;

export type MessageKey = keyof typeof enUS;
export type Dictionary = Record<MessageKey, string>;
export const dictionaries = {
  'en-US': enUS,
  'zh-CN': {
    appName: 'Diary', newEntry: '新建日记', save: '保存', cancel: '取消',
    deleteEntry: '删除日记', search: '搜索', settings: '设置',
    username: '用户名', bio: '个人简介', avatar: '头像', language: '语言',
    signInGoogle: '使用 Google 登录', signInMicrosoft: '使用 Microsoft 登录',
    localAccount: '本地加密账户', password: '密码', pin: 'PIN 码',
    lock: '锁定', unlock: '解锁', encrypt: '加密', decrypt: '解密',
    confirmPasscode: '确认密码', changePasscode: '修改密码',
    plugins: '插件', skills: '技能', agent: 'AI 助手',
    background: '背景', music: '背景音乐', weather: '天气', location: '位置',
    permissionDenied: '权限不足', entrySaved: '已保存 {title}', entryCount: '日记数量：{count}',
  },
  'zh-TW': {
    appName: 'Diary', newEntry: '新增日記', save: '儲存', cancel: '取消',
    deleteEntry: '刪除日記', search: '搜尋', settings: '設定',
    username: '使用者名稱', bio: '個人簡介', avatar: '頭像', language: '語言',
    signInGoogle: '使用 Google 登入', signInMicrosoft: '使用 Microsoft 登入',
    localAccount: '本機加密帳戶', password: '密碼', pin: 'PIN 碼',
    lock: '鎖定', unlock: '解鎖', encrypt: '加密', decrypt: '解密',
    confirmPasscode: '確認密碼', changePasscode: '變更密碼',
    plugins: '外掛', skills: '技能', agent: 'AI 助理',
    background: '背景', music: '背景音樂', weather: '天氣', location: '位置',
    permissionDenied: '權限不足', entrySaved: '已儲存 {title}', entryCount: '日記數量：{count}',
  },
  'ja-JP': {
    appName: 'Diary', newEntry: '日記を作成', save: '保存', cancel: 'キャンセル',
    deleteEntry: '日記を削除', search: '検索', settings: '設定',
    username: 'ユーザー名', bio: '自己紹介', avatar: 'アバター', language: '言語',
    signInGoogle: 'Google でログイン', signInMicrosoft: 'Microsoft でログイン',
    localAccount: 'ローカル暗号化アカウント', password: 'パスワード', pin: 'PIN',
    lock: 'ロック', unlock: 'ロック解除', encrypt: '暗号化', decrypt: '復号',
    confirmPasscode: 'パスコードを確認', changePasscode: 'パスコードを変更',
    plugins: 'プラグイン', skills: 'スキル', agent: 'AI エージェント',
    background: '背景', music: 'BGM', weather: '天気', location: '位置情報',
    permissionDenied: '権限がありません', entrySaved: '{title} を保存しました', entryCount: '日記数：{count}',
  },
  'ko-KR': {
    appName: 'Diary', newEntry: '새 일기', save: '저장', cancel: '취소',
    deleteEntry: '일기 삭제', search: '검색', settings: '설정',
    username: '사용자 이름', bio: '소개', avatar: '아바타', language: '언어',
    signInGoogle: 'Google로 로그인', signInMicrosoft: 'Microsoft로 로그인',
    localAccount: '로컬 암호화 계정', password: '비밀번호', pin: 'PIN',
    lock: '잠금', unlock: '잠금 해제', encrypt: '암호화', decrypt: '복호화',
    confirmPasscode: '암호 확인', changePasscode: '암호 변경',
    plugins: '플러그인', skills: '스킬', agent: 'AI 에이전트',
    background: '배경', music: '배경 음악', weather: '날씨', location: '위치',
    permissionDenied: '권한이 없습니다', entrySaved: '{title} 저장됨', entryCount: '일기 수: {count}',
  },
} as const satisfies Record<string, Dictionary>;
export type Locale = keyof typeof dictionaries;
