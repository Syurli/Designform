"""明确执行的候选界面检查：连接真实本地 HTTP 工作台和独立虚构项目，不拦截业务 API。"""
import os, json, pathlib, time
from playwright.sync_api import sync_playwright, expect
out = pathlib.Path(os.environ.get('CEWEN_QA_OUTPUT', 'qa-output'))
out.mkdir(parents=True, exist_ok=True)
url = os.environ.get('CEWEN_URL', 'http://127.0.0.1:5199')
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    context = browser.new_context(viewport={'width':1440,'height':1000}, permissions=['clipboard-read','clipboard-write'])
    page = context.new_page()
    page.add_init_script("localStorage.setItem('cewen-tutorial-progress-v1',JSON.stringify({'first-launch':{version:1,status:'skipped',step:0,completed:[],skipped:[],updatedAt:new Date().toISOString()}}));")
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.goto(url, wait_until='networkidle', timeout=90000)
    page.locator('[data-view=creative]').click()
    expect(page.locator('.creative-workspace')).to_be_visible()
    # 真实应用事件只用于稳定导航；所有编辑、提交和播放器操作均点击实际控件。
    def open_object(identity, action='object'):
        page.evaluate("d=>window.dispatchEvent(new CustomEvent('cewen:creative-request',{detail:d}))", {'action':action,'objectId':identity})
    open_object('check-use-combat')
    expect(page.locator('[data-object-edit="check-use-combat"]')).to_be_visible()
    page.locator('[data-object-edit="check-use-combat"]').click()
    stage=page.locator('.map-editor-canvas svg')
    expect(stage).to_be_visible()
    before=page.locator('[data-map-layer] [data-map-mark]').count()
    page.locator('[data-map-tool=point]').click()
    stage.click(position={'x':220,'y':150})
    expect(page.locator('[data-map-layer] [data-map-mark]')).to_have_count(before+1)
    page.locator('[data-map-label]').fill('浏览器实际添加的练习点')
    page.screenshot(path=str(out/'01-map-edit.png'), full_page=True)
    page.locator('dialog[open] [data-tutorial=creative-save]').click()
    expect(page.locator('dialog[open].creative-editor')).to_have_count(0, timeout=30000)
    open_object('check-use-combat')
    expect(page.locator('.creative-content')).to_contain_text('浏览器实际添加的练习点')
    open_object('check-map-station')
    expect(page.locator('.creative-content')).not_to_contain_text('浏览器实际添加的练习点')
    # 问题筛选与当前轮次原话从真实项目服务读取。
    open_object('check-quest0','open-quest')
    expect(page.locator('[data-tutorial=quest-workspace]')).to_be_visible()
    page.screenshot(path=str(out/'02-quest.png'), full_page=True)
    # 有声排演必须推进真实时码，不能只有静态分镜图片。
    open_object('check-sequence','play')
    expect(page.locator('[data-tutorial=animatic-player]')).to_be_visible()
    clock=page.locator('[data-clock]')
    initial=clock.inner_text()
    page.locator('[data-play]').click()
    page.wait_for_timeout(1800)
    assert clock.inner_text()!=initial, '播放后的时码没有推进'
    page.locator('[data-play]').click()
    page.locator('[data-next]').click()
    page.screenshot(path=str(out/'03-animatic.png'), full_page=True)
    # 生产界面为固定任务，不自动提交外部模型。
    open_object('check-production','production')
    expect(page.locator('[data-tutorial=production-panel]')).to_be_visible()
    page.screenshot(path=str(out/'04-production.png'), full_page=True)
    # 预设选择不改变任何项目模块能力；窄屏操作区域应可访问。
    page.set_viewport_size({'width':900,'height':900})
    open_object('check-use-combat')
    page.screenshot(path=str(out/'05-narrow.png'), full_page=True)
    page.set_viewport_size({'width':1440,'height':1000})
    page.locator('#tutorial-help').click()
    expect(page.locator('#tutorial-menu')).to_be_visible()
    page.screenshot(path=str(out/'06-tutorial-center.png'), full_page=True)
    result={'url':url,'actualHttpBackend':True,'apiMocked':False,'screenshots':6,'mapOverlayIsolation':True,'animaticClockAdvanced':True,'pageErrors':errors}
    (out/'browser-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    browser.close()
    if errors: raise AssertionError('\n'.join(errors))
print('PASS real HTTP browser: map edit/save/isolation, Quest, animatic clock, production panel, tutorial center and narrow viewport')
