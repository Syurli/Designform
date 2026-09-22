/* 在主界面加载前恢复主题，避免浅色偏好下先闪出深色背景。 */
(() => {
  let theme = 'dark';
  try { if (localStorage.getItem('cewen-theme') === 'light') theme = 'light'; } catch { /* 无存储权限时保留默认。 */ }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
