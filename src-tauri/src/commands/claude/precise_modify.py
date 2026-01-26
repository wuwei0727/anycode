# -*- coding: utf-8 -*-
with open('project_store.rs', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# 精确替换: 从第90行开始
# 90: 旧注释 -> 新注释 + 验证代码
# 91: sessions.push -> if has_user_message { sessions.push
# 92: 空行 -> 空行
# 93-104: if let Ok... 整个块需要缩进4个空格
# 105: } -> 两个 } (一个闭合 has_user_message 的 if, 一个闭合 session_id 的 if)

output = lines[:89]  # 保留前89行 (0-88)

# 添加新代码 (从第90行开始)
output.append('                                    // 验证会话是否有效(有用户消息)才计入统计\n')
output.append('                                    let metadata = extract_session_metadata(&session_path);\n')
output.append('                                    let has_user_message = metadata.first_message\n')
output.append('                                        .as_ref()\n')
output.append('                                        .map(|msg| !msg.trim().is_empty())\n')
output.append('                                        .unwrap_or(false);\n')
output.append('\n')
output.append('                                    if has_user_message {\n')
output.append('                                        sessions.push(session_id.to_string());\n')
output.append('\n')
output.append('                                        if let Ok(session_metadata) = fs::metadata(&session_path) {\n')
output.append('                                            let session_modified = session_metadata\n')
output.append('                                                .modified()\n')
output.append('                                                .unwrap_or(SystemTime::UNIX_EPOCH)\n')
output.append('                                                .duration_since(SystemTime::UNIX_EPOCH)\n')
output.append('                                                .unwrap_or_default()\n')
output.append('                                                .as_secs();\n')
output.append('\n')
output.append('                                            if session_modified > latest_activity {\n')
output.append('                                                latest_activity = session_modified;\n')
output.append('                                            }\n')
output.append('                                        }\n')
output.append('                                    }\n')

# 跳过原来的第 90-104 行,从第 105 行开始保留
output.extend(lines[105:])

with open('project_store.rs', 'w', encoding='utf-8') as f:
    f.writelines(output)

print("修改完成")
