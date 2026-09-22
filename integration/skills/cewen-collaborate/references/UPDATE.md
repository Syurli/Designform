# 更新策划

重新读取基础修订、目标 DD 和关联问题哈希。候选 changes 保留无关段落与原始回答；dependencies 包含问题及其他决策依据。提交提案后由用户在策问选择采纳，问题的逐 DD 落实表跟随实际选择。FILE_CONFLICT/DEPENDENCY_CHANGED/QUESTION_CHANGED 时重新核对，不能拿空哈希绕过。

用户明确授权直接写文件时，先 begin-batch，保存全部当前文件后 end-batch 并记录返回修订；未结束时报告仍在进行。不要修改旧 versions 快照。模型切换时交接当前修订、文档和问题 ID，不依赖本次聊天记忆。
