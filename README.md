# dsh-annotate

像在 Word 里一样，在对话里对助手的回答做**高亮 / 下划线 / 删除 / 批注 / 改写**，
并把「你修改后的样子」在下一轮作为上下文送给助手。

A DeepSeek Harness bundle: Word-like annotations on assistant answers, fed back
to the model as context on the next turn, with a confirmation signal from the model.

## 用起来是什么样

1. 在任意一条回答里选中一段文字，Harness 自带的选区浮条会出现，里面是本插件的操作：
   **引用 · 高亮 · 下划线 · 删除 · 批注 · 改写 · 清除标记**。
2. 高亮/下划线/删除点一下即生效；批注和改写会展开一个小输入框，写完按「确定」（或 Ctrl+Enter）。
3. 输入框左侧有「标注注入」开关，可在**精简**和**完整**之间切换，并显示待处理数量：
   - 精简：下一轮只发送被标注的段落和少量上下文；
   - 完整：下一轮发送整条回答的修订视图（标记内嵌在原文里）。
4. 顶栏右上角的标注图标打开面板：看全部标注、状态（待处理 / 助手已处理 / 自动收起）、单条删除、
   标为已处理、重新提交。

## 五种标注对助手的含义

| 操作 | 含义 |
|---|---|
| 高亮 | 这是我要的：保留并强化这个方向 |
| 下划线 | 这里不够：展开、澄清或给出依据 |
| 删除 | 去掉：下一版不要再出现 |
| 批注 | 按批注内容处理，并逐条回应 |
| 改写 | 以用户改写后的文字为准 |

## 助手怎么「看到」并回应标注

- **步骤前注入**：每一轮开始时，Host 把当前对话里所有待处理的标注渲染成一条用户上下文消息，
  紧跟在你的消息之后进入模型（走官方 `agent/pre-step` 钩子，像其它上下文插件一样落进会话日志）。
- **协议段落**：对话有待处理标注时，系统提示词里多一小段，解释五种标注的含义和确认方式。
- **回传信号**：助手处理完后调用 `annotations` 工具（`action: resolve`，可带 `ids`）确认；
  已确认的标注不再注入，面板里显示「助手已处理」。没确认的会在下一轮再次出现，
  连续 `maxInjections`（默认 3）轮未确认则自动收起，避免无限重发。
- 你也可以在面板里手动「标为已处理」或「重新提交」。

## 结构

```
dsh-annotate/
├── package.json        # dsh.bundle.patch + dsh.client(platform: web)
├── cordis.patch.yml    # 往 profile 插件树插入一行（可配 defaultMode / maxInjections）
├── index.js            # Host：HTTP 路由、annotations 工具、pre-step 注入、协议段落
├── src/store.js        # 标注持久化（状态、注入计数、按会话的模式、消息全文捕获）
├── src/inject.js       # 注入文本：精简视图 / 完整修订视图
├── client.js           # Client：选区浮条、模式开关、面板、CSS 高亮绘制
├── locale/{en,zh}.json # 插件管理页里的名称与描述
└── test/               # node:test 单测（store + HTTP + 注入 + 监听器）
```

## 实现要点

- **选区交互复用官方机制**：注册 `conversation.chat.text-interaction` 槽位（接管内置「引用」的面板并保留引用按钮），
  浮条由 Chat 视图自己定位、随滚动移动，不再自己监听鼠标。
- **不依赖宿主 DOM 结构**：标注记录选中原文 + 前后文 + 滚动容器 CSS 路径，恢复时按原文和前后文打分重新定位；
  另外在消息正文（官方的 `data-text-interaction-source` 元素）里记录偏移并捕获全文，供完整模式渲染修订视图。
- **绘制用 CSS Custom Highlight API**，五种样式各有待处理/已处理两种颜色；不往消息 DOM 里插节点。
- **HTTP 通道**：`/plugins/dsh-annotate/annotations`，GET 与 POST（list / add / remove / clear / resolve / reopen / set-mode）。
- 标注存在 `$DSH_HOME/annotations/state.json`，按会话分组；与会话日志无关，删会话不会自动删标注。

## 安装

在 Harness 里安装本地目录形式的 bundle：插件页 → **添加插件** → 本地目录；或让智能体调用
`plugin_manager` 的 `install_bundle`。Client 半边改动后需要重启 Harness。

## 限制

- 改写只能让助手「知道你改成了什么」，助手看到的历史仍是它原来的回答；这是有意为之，不改会话日志。
- 完整模式按消息全文内嵌标记，重叠的标注会退回到精简列出。
- 标注只对当前渲染在页面里的消息绘制；长对话里被虚拟化滚出屏幕的消息，滚回来时重新定位。
- 多智能体场景未做特别处理：标注按会话存储，子会话各自独立。
