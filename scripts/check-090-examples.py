"""在独立虚构服务上核对示例只读入口和预设分流；不触碰用户项目。"""
import os
from playwright.sync_api import sync_playwright, expect

url = os.environ.get('CEWEN_URL', 'http://127.0.0.1:5199')
errors = []
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, args=['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    page = browser.new_page(viewport={'width': 1440, 'height': 960})
    page.add_init_script("localStorage.setItem('cewen-tutorial-progress-v1',JSON.stringify({'first-launch':{version:1,status:'skipped',step:0,completed:[],skipped:[],updatedAt:new Date().toISOString()}}));")
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(url, wait_until='networkidle', timeout=90000)
    library = page.locator('dialog.library-dialog')
    expect(library).to_be_visible()
    expect(library).to_contain_text('最近项目 0')
    library.locator('[data-action=example]').click()
    hub = page.locator('dialog.example-hub')
    expect(hub).to_be_visible()
    expect(hub).to_contain_text('浏览本身不会创建项目或文件')
    hub.locator('[data-sample=film]').click()
    expect(hub.locator('[data-content]')).to_contain_text('影像表达')
    expect(hub.locator('[data-content]')).to_contain_text('分镜与排演')
    hub.locator('[data-sample=basic]').click()
    expect(hub.locator('[data-content]')).to_contain_text('专项设计')
    hub.locator('[data-close]').click()
    expect(hub).to_have_count(0)
    expect(library).to_contain_text('最近项目 0')
    library.locator('[data-action=creative-project]').click()
    preset = page.locator('dialog.creative-editor')
    expect(preset).to_be_visible()
    expect(preset).to_contain_text('从预设新建项目')
    assert preset.locator('[name=sample], [name=demo]').count() == 0
    assert preset.locator('[name=directory]').get_attribute('required') is not None
    preset.locator('[data-close]').first.click()
    assert not errors, errors
    browser.close()
print('PASS read-only example hub, category preview, preset-only new project, no page errors')
