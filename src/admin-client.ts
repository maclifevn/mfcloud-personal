import { adminIcons } from "./admin-page";

// Served as an authenticated, same-origin script. Data is escaped before HTML
// rendering; no inline handlers, third-party scripts, or credentials in storage.
export const adminScript =
  `"use strict"; const icons = ${JSON.stringify(adminIcons)};` +
  String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = (name) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || icons.file) + '</svg>';
  const format = new Intl.NumberFormat('vi-VN', {maximumFractionDigits:1});
  const number = (n) => format.format(Number(n) || 0);
  function bytes(n) { n = Number(n) || 0; const units = ['B','KB','MB','GB','TB']; let i = 0; while(n >= 1000 && i < 4) { n /= 1000; i++; } return number(n) + ' ' + units[i]; }
  const chartDate = (n) => new Intl.DateTimeFormat('vi-VN',{day:'2-digit',month:'2-digit',timeZone:'UTC'}).format(n*1000);
  const date = (n, time = false) => n ? new Intl.DateTimeFormat('vi-VN', {day:'2-digit',month:'2-digit',year:'numeric',...(time ? {hour:'2-digit',minute:'2-digit'} : {})}).format(n * 1000) : '—';
  const source = (s) => ({finder:'Finder',dropTray:'Drop Tray',connectionTest:'Kiểm tra kết nối'}[s] || s);
  const labels = {ready:'Đang mở',uploading:'Đang tải',expired:'Hết hạn',deleting:'Chờ xóa',deleted:'Đã xóa',blocked:'Đã khóa',active:'Hoạt động',unavailable:'Mã link đã ngừng hỗ trợ'};
  const badge = (s) => '<span class="status ' + (Object.hasOwn(labels,s) ? s : '') + '">' + esc(labels[s] || s) + '</span>';
  const views = {
    overview:{title:'Tổng quan',description:'Mọi chia sẻ, trong tầm kiểm soát.',heading:'Chia sẻ gần đây',note:'Các bộ chia sẻ mới nhất từ Finder và Drop Tray.'},
    shares:{title:'Chia sẻ',description:'Tìm, kiểm tra và quản lý từng bộ chia sẻ.',heading:'Danh sách chia sẻ',note:'Bao gồm link đang mở, phiên upload và các bộ đã thu hồi.',placeholder:'Tên file, mã link, ID chia sẻ hoặc tài khoản…',filters:{all:'Tất cả trạng thái',ready:'Đang mở',uploading:'Đang tải',expired:'Hết hạn',deleting:'Chờ xóa',deleted:'Đã xóa',blocked:'Đã khóa',unavailable:'Mã link đã ngừng hỗ trợ'}},
    accounts:{title:'Tài khoản',description:'Theo dõi dung lượng và quyền sử dụng Cloud MFinder.',heading:'Tài khoản cloud',note:'Mỗi license dùng chung một tài khoản và quota giữa các máy.',placeholder:'Tìm theo ID tài khoản / license…',filters:{all:'Tất cả tài khoản',active:'Hoạt động',blocked:'Đã khóa'}},
    reports:{title:'Báo cáo vi phạm',description:'Kiểm tra phản ánh trước khi quyết định xử lý.',heading:'Báo cáo đã nhận',note:'“Link đang mở” là trạng thái chia sẻ, không phải kết luận vi phạm.',placeholder:'Nội dung báo cáo, mã link, ID tài khoản…',filters:{all:'Tất cả báo cáo',active:'Link đang mở',closed:'Link đã đóng'}},
    events:{title:'Nhật ký quản trị',description:'Lịch sử thay đổi do quản trị viên thực hiện.',heading:'Hoạt động quản trị',note:'Ghi nhận người thực hiện, đối tượng và thời điểm thay đổi.',placeholder:'Tìm email quản trị hoặc ID đối tượng…'}
  };
  let view = 'overview', rows = [], nextCursor = null, overview = null, currentDetail = null, pending = null;
  let generation = 0, detailGeneration = 0, controller = null, busy = false, mutating = false, toastTimer;
  let query = '', filter = 'all', accountFilter = '';
  function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
  function errorMessage(error) {
    if(error.code === 'admin_required' || error.status === 401 || error.status === 403) return 'Phiên quản trị đã hết hạn hoặc không có quyền. Tải lại trang để đăng nhập Cloudflare Access.';
    if(error.code === 'not_found') return 'Không tìm thấy đối tượng. Hãy làm mới danh sách.';
    if(error.code === 'rate_limited') return 'Có quá nhiều yêu cầu. Vui lòng thử lại sau ít phút.';
    if(error.code === 'invalid_search' || error.code === 'invalid_status') return 'Bộ lọc không hợp lệ. Kiểm tra nội dung tìm kiếm.';
    return 'Không thể xác nhận kết quả từ máy chủ. Kiểm tra kết nối và thử lại.';
  }
  async function api(path, options = {}) {
    const timeout = new AbortController();
    const onAbort = () => timeout.abort();
    const timer = setTimeout(() => timeout.abort(), 15000);
    if(options.signal?.aborted) timeout.abort();
    options.signal?.addEventListener('abort',onAbort,{once:true});
    try {
      const response = await fetch(path, {credentials:'same-origin',redirect:'error',cache:'no-store',...options,signal:timeout.signal});
      if(!response.headers.get('content-type')?.includes('application/json')) throw new Error('Unexpected response');
      const result = await response.json();
      if(!response.ok) { const error = new Error(result.error || 'Request failed'); error.code = result.error; error.status = response.status; throw error; }
      return result;
    } catch(error) {
      if(timeout.signal.aborted && !options.signal?.aborted) throw new Error('Request timeout');
      throw error;
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort',onAbort);
    }
  }
  function showError(error) {
    $('error').replaceChildren(); const message = document.createElement('span'); message.textContent = errorMessage(error); $('error').append(message);
    const retry = document.createElement('button'); retry.className = 'button'; retry.textContent = 'Thử lại'; retry.addEventListener('click', () => load()); $('error').append(retry);
    const reload = document.createElement('a'); reload.href = '/'; reload.textContent = 'Tải lại trang'; $('error').append(reload); $('error').hidden = false;
  }
  function empty(title, note, name = 'file') { return '<div class="empty"><div class="empty-icon">' + icon(name) + '</div><h3>' + esc(title) + '</h3><p>' + esc(note) + '</p></div>'; }
  function metric(label, value, note, name, color='') { return '<article class="metric panel"><div class="metric-top"><span>' + label + '</span><span class="metric-icon ' + color + '">' + icon(name) + '</span></div><div class="metric-value">' + value + '</div><div class="metric-note">' + note + '</div></article>'; }
  function renderOverview(data) {
    overview = data;
    const s = data.stats;
    $('metrics').innerHTML = metric('Link đang mở',number(s.activeShares),'<strong>' + number(s.uploadingShares) + '</strong> phiên đang tải','link') +
      metric('Dung lượng sử dụng',esc(bytes(s.usedBytes)).replace(' ','<small>') + '</small>',esc(bytes(s.reservedBytes)) + ' đang giữ cho upload','disk','green') +
      metric('Tài khoản cloud',number(s.accounts),number(s.blockedAccounts) + ' tài khoản đã khóa','users') +
      metric('Báo cáo vi phạm',number(s.reports),number(s.activeReports) + ' báo cáo trên link đang mở','flag','orange');
    $('metrics').setAttribute('aria-busy','false');
    const total = data.activity.reduce((sum, d) => sum + d.count, 0), max = Math.max(1,...data.activity.map(d => d.count));
    $('activity').innerHTML = '<div class="chart-summary">' + number(total) + '<span>link được công bố</span></div><div class="chart" role="img" aria-label="' + esc(data.activity.map(d => chartDate(d.day) + ': ' + d.count + ' link').join('; ')) + '">' + data.activity.map(d => '<div class="chart-column"><span class="bar-value">' + number(d.count) + '</span><div class="bar" style="height:' + Math.round(d.count/max*92) + 'px"></div></div>').join('') + '</div><div class="chart-labels" aria-hidden="true">' + data.activity.map(d => '<span>' + new Intl.DateTimeFormat('vi-VN',{day:'2-digit',month:'2-digit',timeZone:'UTC'}).format(d.day*1000) + '</span>').join('') + '</div>';
    $('activity').setAttribute('aria-busy','false');
    const o = data.operations;
    $('operations').innerHTML = '<div class="operation"><span>Nhận upload<small>' + ({beta:'Chỉ license trong nhóm beta',licensed:'License hợp lệ',personal:'Cloud cá nhân'}[o.admission] || '') + '</small></span><span class="status ' + (o.uploadsEnabled ? 'active' : 'expired') + '">' + (o.uploadsEnabled ? 'Đang bật' : 'Tạm dừng') + '</span></div><div class="operation"><span>Chờ xóa dữ liệu<small>' + number(s.pendingDeletes) + ' bộ chia sẻ · ' + number(s.retryDeletes) + ' đang thử lại</small></span><span class="operation-value">' + esc(bytes(s.pendingDeleteBytes)) + '</span></div><div class="operation"><span>Dọn dữ liệu hết hạn<small>' + number(s.expiredAwaitingCleanup) + ' bộ chờ Cron tiếp nhận</small></span><span class="operation-value">Mỗi ' + number(o.cleanupIntervalMinutes) + ' phút</span></div><p class="cleanup-note">Link bị chặn ngay khi hết hạn hoặc thu hồi. Dữ liệu chờ xóa không tính vào quota; số byte trên đây là kích thước manifest chờ dọn.</p>';
    $('operations').setAttribute('aria-busy','false');
    $('report-count').textContent = number(s.activeReports); $('report-count').hidden = !s.activeReports;
  }
  function publicURL(item) {
    if(item.status !== 'ready' || !/^[A-Za-z0-9]{6}$/.test(item.token) || !overview) return null;
    try { const url = new URL('/' + item.token,overview.publicOrigin); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
  }
  function rowAction(action, id, title, name) { return '<button class="icon-button" data-action="' + action + '" data-id="' + esc(id) + '" aria-label="' + esc(title) + '" title="' + esc(title) + '">' + icon(name) + '</button>'; }
  function shareTitle(item) { return item.name ? item.name + (item.file_count > 1 ? ' +' + (item.file_count - 1) : '') : 'Bộ chia sẻ'; }
  function shareRows(items) {
    return '<div class="table-scroll" role="region" aria-label="Danh sách chia sẻ" tabindex="0"><table><thead><tr><th scope="col">Bộ chia sẻ</th><th scope="col">Trạng thái</th><th scope="col">Dung lượng</th><th scope="col" class="hide-compact">Hết hạn</th><th scope="col">Thao tác</th></tr></thead><tbody>' + items.map(item => {
      const url = publicURL(item);
      return '<tr><td><div class="file-cell"><span class="file-icon">' + icon('file') + '</span><div class="file-text"><button class="file-title" data-action="detail" data-id="' + esc(item.id) + '" title="' + esc(shareTitle(item)) + '">' + esc(shareTitle(item)) + '</button><div class="file-meta"><span class="mono">' + esc(item.token) + '</span><span>·</span><span class="source">' + esc(source(item.source)) + '</span><span>· ' + number(item.file_count) + ' file</span></div></div></div></td><td>' + badge(item.status) + '</td><td class="nowrap">' + esc(bytes(item.bytes)) + '</td><td class="nowrap hide-compact">' + date(item.expires_at) + '</td><td><div class="row-actions">' + (url ? rowAction('copy',item.id,'Copy link ' + item.token,'copy') + '<a class="icon-button" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" aria-label="Mở link ' + esc(item.token) + '" title="Mở trang nhận">' + icon('arrow') + '</a>' : '') + rowAction('detail',item.id,'Chi tiết ' + shareTitle(item),'search') + '</div></td></tr>';
    }).join('') + '</tbody></table></div>';
  }
  function accountRows(items) {
    return '<div class="table-scroll" role="region" aria-label="Danh sách tài khoản" tabindex="0"><table><thead><tr><th>Tài khoản / license</th><th>Trạng thái</th><th>Dung lượng</th><th>Link đang mở</th><th>Thao tác</th></tr></thead><tbody>' + items.map(item => '<tr><td><span class="account-id mono">' + esc(item.id) + '</span><span class="muted">Tạo ngày ' + date(item.created_at) + '</span></td><td>' + badge(item.status) + '</td><td class="nowrap">' + esc(bytes(item.usedBytes)) + ' / ' + esc(bytes(item.quota_bytes)) + '<div class="muted">Đang giữ ' + esc(bytes(item.reservedBytes)) + '</div></td><td>' + number(item.activeShares) + '</td><td><div class="row-actions">' + rowAction('account-shares',item.id,'Xem chia sẻ của tài khoản','link') + (item.status === 'active' ? rowAction('block',item.id,'Khóa tài khoản','shield') : '') + '</div></td></tr>').join('') + '</tbody></table></div>';
  }
  function reportRows(items) {
    return '<div class="table-scroll" role="region" aria-label="Báo cáo vi phạm" tabindex="0"><table><thead><tr><th>Báo cáo</th><th>Link liên quan</th><th>Trạng thái link</th><th>Thao tác</th></tr></thead><tbody>' + items.map(item => '<tr><td><p class="report-reason">' + esc(item.reason) + '</p><span class="muted">' + date(item.created_at,true) + ' · <span class="mono">' + esc(item.id) + '</span></span></td><td><span class="mono">' + esc(item.token) + '</span><div class="muted id-cell">' + esc(item.account_id) + '</div></td><td>' + badge(item.status) + '</td><td><button class="button" data-action="detail" data-id="' + esc(item.share_id) + '">Kiểm tra</button></td></tr>').join('') + '</tbody></table></div>';
  }
  function eventRows(items) {
    return '<div class="table-scroll" role="region" aria-label="Nhật ký quản trị" tabindex="0"><table><thead><tr><th>Hành động</th><th>Người thực hiện</th><th>Đối tượng</th><th>Thời điểm</th></tr></thead><tbody>' + items.map(item => '<tr><td><span class="audit-action">' + icon(item.action.includes('block') ? 'shield' : 'trash') + (item.action === '/admin/block-account' ? 'Khóa tài khoản' : item.action === '/admin/delete-share' ? 'Thu hồi chia sẻ' : esc(item.action)) + '</span></td><td>' + esc(item.actor) + '</td><td class="id-cell mono">' + esc(item.target_id) + '</td><td class="nowrap">' + date(item.created_at,true) + '</td></tr>').join('') + '</tbody></table></div>';
  }
  function renderList() {
    const entity = view === 'overview' ? 'shares' : view, visible = view === 'overview' ? rows.slice(0,5) : rows;
    const emptyText = {shares:['Chưa có chia sẻ','Các bộ chia sẻ từ Finder và Drop Tray sẽ xuất hiện tại đây.','link'],accounts:['Chưa có tài khoản cloud','Tài khoản xuất hiện khi người dùng kết nối Cloud MFinder.','users'],reports:['Chưa có báo cáo vi phạm','Báo cáo từ trang nhận file sẽ được tập hợp tại đây.','flag'],events:['Chưa có thao tác quản trị','Thao tác thu hồi chia sẻ và khóa tài khoản sẽ được ghi lại.','history']}[entity];
    $('list').innerHTML = visible.length ? ({shares:shareRows,accounts:accountRows,reports:reportRows,events:eventRows}[entity])(visible) : query || filter !== 'all' ? empty('Không tìm thấy kết quả','Thử từ khóa khác hoặc chọn tất cả trạng thái.','search') : empty(...emptyText);
    $('result-count').textContent = visible.length ? (view === 'overview' ? visible.length + ' bộ chia sẻ gần nhất' : 'Đang hiển thị ' + visible.length + ' kết quả') : '0 kết quả';
    $('more').hidden = !nextCursor || view === 'overview';
  }
  async function load(append = false) {
    const requestGeneration = ++generation;
    controller?.abort(); controller = new AbortController(); const signal = controller.signal;
    busy = true; $('refresh').disabled = true; $('more').disabled = true; $('error').hidden = true; $('list').setAttribute('aria-busy','true');
    $('updated').textContent = 'Đang cập nhật…';
    const entity = view === 'overview' ? 'shares' : view;
    const params = new URLSearchParams({q:query,status:filter}); if(accountFilter) params.set('accountId',accountFilter); if(append && nextCursor) params.set('cursor',nextCursor);
    if(!append) { rows = []; nextCursor = null; $('list').innerHTML = empty('Đang tải dữ liệu','Vui lòng chờ trong giây lát.','refresh'); $('result-count').textContent = ''; $('more').hidden = true; }
    try {
      const [data, items] = await Promise.all([api('/admin/api/overview',{signal}),api('/admin/api/' + entity + '?' + params,{signal})]);
      if(requestGeneration !== generation) return;
      renderOverview(data); rows = append ? rows.concat(items.items.filter(item => !rows.some(r => r.id === item.id))) : items.items; nextCursor = items.nextCursor; renderList();
      $('updated').textContent = 'Cập nhật ' + new Intl.DateTimeFormat('vi-VN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(data.serverTime*1000);
    } catch(error) {
      if(requestGeneration !== generation || error.name === 'AbortError') return;
      showError(error); $('updated').textContent = 'Chưa cập nhật được';
      if(!append) $('list').innerHTML = empty('Chưa tải được dữ liệu','Dùng nút Thử lại phía trên để kết nối lại.','cloud');
    } finally {
      if(requestGeneration === generation) { busy = false; $('refresh').disabled = false; $('more').disabled = false; $('list').setAttribute('aria-busy','false'); }
    }
  }
  function navigate(next, search = '', accountId = '') {
    if(!views[next]) return;
    view = next; query = search; filter = 'all'; accountFilter = accountId; const meta = views[view];
    document.querySelectorAll('.nav-item').forEach(button => { const selected = button.dataset.view === view; button.classList.toggle('selected',selected); if(selected) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); });
    $('page-title').textContent = meta.title; document.title = meta.title + ' · MFCloud'; $('page-description').textContent = meta.description; $('collection-title').textContent = meta.heading; $('collection-description').textContent = meta.note;
    $('overview').hidden = view !== 'overview'; $('see-all').hidden = view !== 'overview'; $('filters').hidden = view === 'overview';
    $('search').value = search; $('search').placeholder = meta.placeholder || ''; $('status').parentElement.hidden = !meta.filters; $('status').innerHTML = Object.entries(meta.filters || {all:'Tất cả'}).map(([value,label]) => '<option value="' + value + '">' + label + '</option>').join('');
    $('account-filter').hidden = !accountFilter; $('account-filter-id').textContent = accountFilter;
    load();
  }
  async function copy(item, button) {
    const url = publicURL(item); if(!url) return;
    try { await navigator.clipboard.writeText(url); const old = button.innerHTML; button.innerHTML = icon('check'); button.title = 'Đã copy'; button.setAttribute('aria-label','Đã copy link'); toast('Đã copy link'); setTimeout(() => { if(button.isConnected) { button.innerHTML = old; button.title = 'Copy link'; button.setAttribute('aria-label','Copy link'); } },2500); }
    catch { toast('Chưa copy được. Mở chi tiết để chọn và sao chép link.'); }
  }
  async function openDetail(id) {
    const requestGeneration = ++detailGeneration; currentDetail = null;
    $('detail-content').innerHTML = empty('Đang tải chi tiết','Đang lấy thông tin mới nhất từ máy chủ.','refresh');
    if(!$('detail').open) $('detail').showModal();
    try {
      const data = await api('/admin/api/shares/' + encodeURIComponent(id));
      if(requestGeneration !== detailGeneration || !$('detail').open) return;
      currentDetail = data.share; const item = data.share, url = publicURL(item);
      $('detail-content').innerHTML = '<div class="detail-hero"><span class="file-icon">' + icon('file') + '</span><div><h3>' + esc(shareTitle(item)) + '</h3>' + badge(item.status) + '</div></div>' + (url ? '<div class="detail-link"><span class="mono">' + esc(url) + '</span>' + rowAction('copy',item.id,'Copy link','copy') + '<a class="button" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Mở trang nhận ' + icon('arrow') + '</a></div>' : '<p class="muted">Link công khai hiện không khả dụng.</p>') + '<dl class="detail-grid"><div><dt>ID chia sẻ</dt><dd class="mono">' + esc(item.id) + '</dd></div><div><dt>Tài khoản / license</dt><dd class="mono">' + esc(item.account_id) + '</dd></div><div><dt>Được tạo từ</dt><dd>' + esc(source(item.source)) + ' · ' + date(item.created_at,true) + '</dd></div><div><dt>Hết hạn</dt><dd>' + date(item.expires_at,true) + '</dd></div><div><dt>Tổng dung lượng</dt><dd>' + esc(bytes(item.bytes)) + ' · ' + number(item.file_count) + ' file</dd></div><div><dt>Công bố lúc</dt><dd>' + date(item.published_at,true) + '</dd></div></dl><h3>File trong bộ chia sẻ</h3><ul class="detail-files">' + data.files.map(file => '<li>' + icon('file') + '<span>' + esc(file.name) + '</span><small>' + esc(bytes(file.bytes)) + '</small></li>').join('') + '</ul>' + (['ready','uploading','expired','unavailable'].includes(item.status) ? '<div class="dialog-actions"><button class="button subtle-danger" data-action="block" data-id="' + esc(item.account_id) + '">' + icon('shield') + 'Khóa tài khoản</button><button class="button danger" data-action="revoke" data-id="' + esc(item.id) + '">' + icon('trash') + 'Thu hồi chia sẻ</button></div>' : '');
    } catch(error) { if(requestGeneration === detailGeneration && $('detail').open) $('detail-content').innerHTML = empty('Không tải được chi tiết',errorMessage(error),'cloud'); }
  }
  function confirmAction(action, id) {
    const item = action === 'revoke' ? currentDetail : rows.find(r => r.id === id);
    const block = action === 'block';
    pending = {action,id}; $('confirm-title').textContent = block ? 'Khóa tài khoản này?' : 'Thu hồi chia sẻ này?';
    $('confirm-description').textContent = block ? 'Chặn mọi upload mới và thu hồi tất cả link của tài khoản này. Dữ liệu cloud sẽ được đưa vào hàng đợi xóa. File trên máy người dùng giữ nguyên.' : 'Link sẽ ngừng hoạt động ngay. Dữ liệu cloud được đưa vào hàng đợi xóa; file gốc và Drop Tray giữ nguyên.';
    $('confirm-target').textContent = block ? id : shareTitle(item) + ' · ' + bytes(item.bytes) + ' · ' + item.token;
    $('confirm-input-label').hidden = !block; $('confirm-input').value = ''; $('confirm-error').hidden = true; $('confirm-action').textContent = block ? 'Khóa tài khoản' : 'Thu hồi chia sẻ'; $('confirm-action').disabled = block; $('cancel-action').disabled = false;
    $('confirm').showModal(); $('cancel-action').focus();
  }
  $('confirm-input').addEventListener('input', () => { $('confirm-action').disabled = mutating || (pending?.action === 'block' && $('confirm-input').value !== pending.id); });
  $('confirm-action').addEventListener('click', async () => {
    if(!pending || mutating || (pending.action === 'block' && $('confirm-input').value !== pending.id)) return;
    mutating = true; $('confirm-action').disabled = true; $('cancel-action').disabled = true; $('confirm-error').hidden = true;
    const action = pending;
    try {
      await api(action.action === 'block' ? '/admin/block-account' : '/admin/delete-share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:action.id})});
      $('confirm').close(); $('detail').close(); toast(action.action === 'block' ? 'Đã khóa tài khoản và thu hồi các link.' : 'Đã thu hồi chia sẻ.'); await load();
    } catch(error) { $('confirm-error').textContent = errorMessage(error); $('confirm-error').hidden = false; }
    finally { mutating = false; $('confirm-action').disabled = false; $('cancel-action').disabled = false; }
  });
  $('confirm').addEventListener('cancel', (event) => { if(mutating) event.preventDefault(); });
  $('detail').addEventListener('close', () => { detailGeneration++; currentDetail = null; });
  document.addEventListener('click', event => {
    const button = event.target.closest('button[data-view],button[data-action],button[data-close]'); if(!button) return;
    if(button.dataset.close) { if(!mutating) $(button.dataset.close).close(); return; }
    if(button.dataset.view) { navigate(button.dataset.view); return; }
    const {action,id} = button.dataset;
    if(action === 'detail') openDetail(id);
    else if(action === 'copy') { const item = currentDetail?.id === id ? currentDetail : rows.find(r => r.id === id); if(item) copy(item,button); }
    else if(action === 'account-shares') navigate('shares','',id);
    else if(action === 'block' || action === 'revoke') confirmAction(action,id);
  });
  $('filters').addEventListener('submit', event => { event.preventDefault(); query = $('search').value.trim(); filter = $('status').value; load(); });
  $('status').addEventListener('change', () => { query = $('search').value.trim(); filter = $('status').value; load(); });
  $('clear-account-filter').addEventListener('click', () => { accountFilter = ''; $('account-filter').hidden = true; load(); });
  $('refresh').addEventListener('click', () => load()); $('more').addEventListener('click', () => { if(!busy && nextCursor) load(true); });
  try { const theme = localStorage.getItem('mfcloud-admin-theme'); if(['light','dark'].includes(theme)) document.documentElement.dataset.theme = theme; } catch {}
  $('theme').addEventListener('click', () => { const theme = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); const next = theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('mfcloud-admin-theme',next); } catch {} $('theme').setAttribute('aria-label',next === 'dark' ? 'Chuyển giao diện sáng' : 'Chuyển giao diện tối'); });
  navigate('overview');
})();
`;
