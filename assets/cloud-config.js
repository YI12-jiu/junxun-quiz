/* 云服务接入配置
 * 取值来自 WorkBuddy 云服务开通时返回的 publicConfig（本应用专用，域名已固定）。
 * endpoint 必须使用本应用已登记的发布域名，否则服务端会因 Origin 不匹配而拒绝请求。
 */
window.CLOUD_CONFIG = {
  endpoint: 'https://junxun-exam.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_ysv3RuaVcgwMU0jYndU3d9_QMwtuMukr06eaTQFCKR2aaSBwDAiK7AC',
  table: 'exam_records',
  teacherLoginRpc: 'teacher_login',
  teacherListRpc: 'teacher_exam_records',
  teacherDeleteRpc: 'teacher_delete_record'
};
