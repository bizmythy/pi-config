local row, byte_col, replacement, target_row, target_byte_col = ...
local buffer = vim.g.pi_prompt_buffer
if not buffer or not vim.api.nvim_buf_is_valid(buffer) then
  return false
end

vim.api.nvim_buf_set_text(buffer, row, byte_col, row, byte_col, replacement)
if vim.api.nvim_get_current_buf() == buffer then
  vim.api.nvim_win_set_cursor(0, { target_row + 1, target_byte_col })
end
return true
