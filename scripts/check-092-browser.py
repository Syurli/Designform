"""明确执行的 0.9.2 工作台验收；真实 HTTP 服务、虚构目录，无业务 API 仿真。"""
import os, json, pathlib, hashlib, sys
from playwright.sync_api import sync_playwright, expect

url = os.environ.get('CEWEN_URL', 'http://127.0.0.1:5199')
out = pathlib.Path(os.environ.get('CEWEN_QA_OUTPUT', 'qa-output'))
out.mkdir(parents=True, exist_ok=True)
mode = sys.argv[1] if len(sys.argv) > 1 else 'desktop'
errors = []

def disk_state():
    root = pathlib.Path(os.environ['CEWEN_HOME'])
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob('*') if p.is_file() and p.name != 'host.json'}

with sync_playwright() as playwright:
    options = {'headless': True, 'args': ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']}
    if os.environ.get('CEWEN_BROWSER'): options['executable_path'] = os.environ['CEWEN_BROWSER']
    browser = playwright.chromium.launch(**options)
    context = browser.new_context(viewport={'width':1440, 'height':960}, permissions=['clipboard-read','clipboard-write'])
    page = context.new_page()
    page.set_default_timeout(20000)
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
    page.goto(url, wait_until='networkidle', timeout=90000)
    expect(page.locator('.desktop-library')).to_be_visible()
    assert page.locator('[data-view=creative],[data-view=quest],[data-view=animatic]').count() == 0

    def api(route):
        return page.evaluate('''async route => {
          const session=await fetch('/api/session').then(r=>r.json());
          return fetch(route,{headers:{'X-Cewen-Session':session.token}}).then(r=>r.json());
        }''', route)

    def example(kind):
        page.locator('[data-examples]').click()
        page.locator('dialog[open] [name=example]').select_option(kind)
        page.locator('dialog[open] [type=submit]').click()
        expect(page.locator('.desktop-work')).to_be_visible(timeout=60000)
        expect(page.locator('[data-session-kind]')).to_contain_text('临时')

    def menu(name):
        page.get_by_role('menuitem', name=name, exact=True).click()

    if mode == 'examples':
        before = disk_state()
        stored_before = page.evaluate('Object.keys(localStorage).sort()')
        example('film')
        expect(page.locator('[data-project-title]')).to_contain_text('最后一盏灯')
        expect(page.locator('.document-tree .project-directory-category-row')).to_have_count(3)
        page.locator('[aria-label=搜索项目文档]').fill('分镜与排演')
        page.locator('.document-tree .project-directory-row', has_text='分镜与排演').click()
        page.locator('.document-tab-content:not([hidden]) [data-sequence-play]:visible').first.click()
        expect(page.locator('[data-tutorial=animatic-player]')).to_be_visible()
        start = page.locator('[data-clock]').inner_text()
        page.locator('[data-play]').click()
        page.wait_for_timeout(1200)
        assert page.locator('[data-clock]').inner_text() != start
        page.locator('[data-play]').click()
        page.screenshot(path=str(out/'092-memory-playback.png'))
        page.locator('.document-context > button').click()
        page.locator('.document-properties [name=title]').fill('中文临时分镜')
        page.keyboard.press('Control+s')
        expect(page.locator('dialog[open]')).to_contain_text('项目另存为')
        page.locator('dialog[open] [data-cancel]').first.click()
        assert disk_state() == before, '另存为取消前发生了本地文件写入'
        assert page.evaluate('Object.keys(localStorage).sort()') == stored_before, '示例编辑写入持久偏好/草稿'
        assert page.evaluate('async()=> (await indexedDB.databases()).length') == 0, '示例打开持久数据库'
        # 返回项目库只挂起会话；此处明确关闭示例，核对放弃后恢复原始内容。
        page.locator('.document-menu [data-file]').click()
        page.get_by_role('menuitem', name='关闭当前项目', exact=True).click()
        page.locator('[value=discard]').check()
        page.locator('dialog[open] [type=submit]').click()
        expect(page.locator('.desktop-library')).to_be_visible()
        example('film')
        expect(page.locator('.document-tree')).not_to_contain_text('中文临时分镜')
        # 确认另存为才创建真实独立工程；媒体与当前草稿都保留。
        page.locator('.document-properties [name=title]').fill('已另存的学习入口')
        page.keyboard.press('Control+s')
        page.locator('dialog[open] [name=name]').fill('0.9.2 示例另存验收')
        page.locator('dialog[open] [type=submit]').click()
        expect(page.locator('[data-session-kind]')).to_have_text('', timeout=60000)
        expect(page.locator('.document-tree')).to_contain_text('已另存的学习入口')
        saved = api('/api/projects')
        project = next(p for p in saved['projects'] if p['name'] == '0.9.2 示例另存验收')
        snapshot = api('/api/projects/'+project['id'])
        assert len(snapshot['media']) >= 2
        page.locator('[data-home]').click()
        # 新建向导首次不选预设，返回保留用户输入，取消不建目录。
        initial = len(api('/api/projects')['projects'])
        page.locator('.library-heading [data-new]').click()
        page.locator('[name=goal]').fill('用于验收的一体化创作设想')
        page.locator('.project-wizard [type=submit]').click()
        assert page.locator('[name=preset]:checked').count() == 0
        page.locator('.project-wizard [type=submit]').click()
        expect(page.locator('[name=prompt]')).to_have_value(__import__('re').compile('.*一体化创作设想.*', __import__('re').S))
        page.locator('.project-wizard [data-close]').first.click()
        assert len(api('/api/projects')['projects']) == initial
    else:
        library = api('/api/projects')
        project = next(p for p in library['projects'] if p['name'] == '0.9 专项验收副本')
        page.locator('.library-project[data-id="'+project['id']+'"] [data-enter]').click()
        expect(page.locator('.desktop-work')).to_be_visible()
        snapshot = api('/api/projects/'+project['id'])
        def open_object(identity):
            doc = next(d for d in snapshot['documents'] if 'id: '+identity+'\n' in d['text'].replace('\r\n','\n'))
            # 搜索实际目录并通过可见条目打开，避免专用面板的旧导航事件。
            page.locator('[aria-label=搜索项目文档]').fill(doc['title'])
            page.locator('.document-tree .project-directory-row[data-id="'+doc['id']+'"]').click()
            return page.locator('.document-tab-content:not([hidden])')
        # 文档及画布同时保留模块投影；只操作可见入口，同一对象的入口共用正式身份。
        active = open_object('check-use-combat')
        active.locator('[data-object-edit="check-use-combat"]:visible').first.click()
        stage=page.locator('.map-editor-canvas svg')
        expect(stage).to_be_visible()
        before=page.locator('[data-map-layer] [data-map-mark]').count()
        page.locator('[data-map-tool=point]').click()
        stage.click(position={'x':120,'y':95})
        expect(page.locator('[data-map-layer] [data-map-mark]')).to_have_count(before+1)
        page.locator('[data-map-label]').fill('0.9.2 局部练习点')
        page.locator('[data-map-label]').press('Tab')
        page.locator('.inline-module-editor [type=submit]').click()
        page.keyboard.press('Control+s')
        page.wait_for_timeout(1000)
        print('SAVE STATUS',page.locator('.document-status').inner_text(),flush=True)
        page.screenshot(path=str(out/'092-save-check.png'))
        expect(page.locator('.document-status')).to_contain_text('已保存', timeout=60000)
        expect(open_object('check-map-station')).not_to_contain_text('0.9.2 局部练习点')
        # 原主面板、三种总览和卡片关系分析必须仍可操作。
        expect(page.locator('.main-nav')).to_be_visible()
        page.locator('.main-nav [data-view=graph]').click()
        for mode_name in ['galaxy','layers','mindmap']:
            page.locator('button[data-mode='+mode_name+']').click()
            expect(page.locator('button[data-mode='+mode_name+']')).to_have_attribute('aria-pressed','true')
            expect(page.locator('#graph-canvas canvas')).to_be_visible()
            page.wait_for_timeout(350)
        page.locator('.document-menu > [data-view]').click()
        page.get_by_role('menuitem',name='当前文档的卡片关系预览',exact=True).click()
        expect(page.locator('#analysis-toolbar')).to_be_visible()
        page.screenshot(path=str(out/'092-retained-relations.png'))
        page.locator('.main-nav [data-view=document]').click()
        expect(page.locator('.document-tree .project-directory-category').first).to_be_visible()
        active=open_object('check-quest0')
        active.locator('[data-quest-open="check-quest0"]:visible').first.click()
        expect(page.locator('.project-question-directory')).to_be_visible()
        expect(page.locator('.question-directory-filters button')).to_have_count(3)
        page.locator('.project-round-questions [data-back]').click()
        active=open_object('check-sequence')
        active.locator('[data-sequence-play="check-sequence"]:visible').first.click()
        expect(page.locator('[data-tutorial=animatic-player]')).to_be_visible()
        start=page.locator('[data-clock]').inner_text()
        page.locator('[data-play]').click()
        page.wait_for_timeout(1400)
        assert page.locator('[data-clock]').inner_text()!=start
        page.locator('[data-play]').click()
        page.locator('.document-context > button').click()
        active=open_object('check-production')
        active.locator('[data-production-open="check-production"]:visible').first.click()
        expect(page.locator('[data-tutorial=production-panel]')).to_be_visible()
        page.locator('.document-context > button').click()
        # 角色卡预设生成普通文档；编辑、保存、菜单限位与窄窗口入口。
        page.locator('.document-tree-panel [data-new]').click()
        page.locator('[data-preset=builtin-character]').click()
        page.locator('dialog[open] [name=name]').fill('0.9.2 中文角色验收')
        page.locator('dialog[open] [type=submit]').click()
        page.locator('.document-properties [name=tags]').fill('自定义人物用途')
        page.keyboard.press('Control+s')
        expect(page.locator('.document-status')).to_contain_text('已保存', timeout=60000)
        page.locator('[aria-label=搜索项目文档]').fill('0.9.2 中文角色验收')
        row=page.locator('.document-tree .project-directory-row',has_text='0.9.2 中文角色验收').last
        row.click(button='right')
        bounds=page.locator('[role=menu]').bounding_box()
        assert bounds['y']+bounds['height']<=960
        page.keyboard.press('Escape')
        expect(page.locator('[role=menu]')).to_have_count(0)
        # 导入媒体先留在当前草稿；确认保存时才创建正式媒体和版本。
        import wave
        fixture=out/'092-fictional-silence.wav'
        with wave.open(str(fixture),'wb') as sound:
            sound.setnchannels(1);sound.setsampwidth(2);sound.setframerate(8000);sound.writeframes(bytes(16000))
        prior=api('/api/projects/'+project['id'])
        # 属性已统一为标签，媒体入口使用当前文档右键插入菜单。
        page.locator('[data-doc-mode=preview]').click()
        page.locator('.document-tab-content:not([hidden]) .desktop-document-preview').click(button='right', position={'x':25,'y':30})
        # 分类项包含展开箭头，按可读标签定位；子命令仍精确匹配。
        page.get_by_role('menuitem', name='图片与媒体', exact=False).click()
        with page.expect_file_chooser() as picker:
            page.get_by_role('menuitem', name='音频 / 媒体…', exact=True).click()
        picker.value.set_files(str(fixture))
        page.locator('dialog[open] [name=permission]').fill('自动生成的虚构静音，仅验收使用')
        page.locator('dialog[open] [type=submit]').click()
        expect(page.locator('dialog:modal')).to_have_count(0)
        assert api('/api/projects/'+project['id'])['revision']==prior['revision'], '插入媒体提前保存了项目'
        page.keyboard.press('Control+s')
        expect(page.locator('.document-status')).to_contain_text('已保存',timeout=60000)
        now=api('/api/projects/'+project['id'])
        assert any('092-fictional-silence.wav' in d['text'] for d in now['documents'])
        # 多文档草稿独立：只保存另一页，不顺带提交当前页的用途。
        role_id=page.locator('.document-tab-content:not([hidden])').get_attribute('data-document-id')
        role=next(d for d in now['documents'] if d['id']==role_id)
        page.locator('.document-properties [name=tags]').fill('尚未保存的个人预设草稿')
        active=open_object('check-map-station')
        page.locator('.document-properties [name=tags]').fill('共享地图说明验收 '+str(now['revision']))
        page.keyboard.press('Control+s')
        expect(page.locator('.document-status')).to_contain_text('已保存',timeout=60000)
        disk=api('/api/projects/'+project['id'])
        assert '尚未保存的个人预设草稿' not in next(d['text'] for d in disk['documents'] if d['id']==role['id'])
        page.locator('[aria-label=搜索项目文档]').fill(role['title'])
        page.locator('.document-tree .project-directory-row[data-id="'+role['id']+'"]').click()
        expect(page.locator('.document-properties [name=tags]')).to_have_value('尚未保存的个人预设草稿')
        page.keyboard.press('Control+s')
        expect(page.locator('.document-status')).to_contain_text('已保存',timeout=60000)
        page.locator('.document-menu [data-file]').click()
        page.get_by_role('menuitem',name='保存当前文档为预设…',exact=True).click()
        page.locator('dialog[open] [name=name]').fill('验收个人角色预设')
        page.locator('dialog[open] [type=submit]').click()
        expect(page.locator('.document-status')).to_contain_text('我的文档预设',timeout=60000)
        presets=api('/api/document-presets')
        assert any(p['name']=='验收个人角色预设' for p in presets)
        page.screenshot(path=str(out/'092-integrated-document.png'))
        page.set_viewport_size({'width':900,'height':800})
        if page.locator('#app').evaluate("e=>e.classList.contains('sidebar-open')"): page.locator('#sidebar-close').click()
        page.locator('.document-tab-content:not([hidden]) [data-object-edit]:visible').first.click()
        expect(page.locator('.document-properties')).to_be_visible()
        page.screenshot(path=str(out/'092-narrow-module.png'))
    (out/('092-'+mode+'-result.json')).write_text(json.dumps({'realHttp':True,'mode':mode,'apiMocked':False,'errors':errors},ensure_ascii=False,indent=2),encoding='utf-8')
    browser.close()
    assert not errors, '\n'.join(errors)
print('PASS 0.9.2 '+mode+': real service and document workbench')
