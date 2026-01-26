# -*- coding: utf-8 -*-
with open('project_store.rs', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# 找到第 90 行(索引89)并替换为新逻辑
# 删除第90行的旧注释,添加新的验证逻辑
# 原第 91 行是 sessions.push,需要变为条件内的代码

# 第 89-105 行需要替换
output_lines = lines[:89]  # 保留前89行

# 添加新的代码
new_code = '''                                    // 验证会话是否有效(有用户消息)才计入统计
                                    let metadata = extract_session_metadata(&session_path);
                                    let has_user_message = metadata.first_message
                                        .as_ref()
                                        .map(|msg| !msg.trim().is_empty())
                                        .unwrap_or(false);

                                    if has_user_message {
                                        sessions.push(session_id.to_string());

                                        if let Ok(session_metadata) = fs::metadata(&session_path) {
                                            let session_modified = session_metadata
                                                .modified()
                                                .unwrap_or(SystemTime::UNIX_EPOCH)
                                                .duration_since(SystemTime::UNIX_EPOCH)
                                                .unwrap_or_default()
                                                .as_secs();

                                            if session_modified > latest_activity {
                                                latest_activity = session_modified;
                                            }
                                        }
                                    }
'''

output_lines.append(new_code)
output_lines.extend(lines[105:])  # 保留105行之后的内容

with open('project_store.rs', 'w', encoding='utf-8') as f:
    f.writelines(output_lines)

print("文件修改完成")
