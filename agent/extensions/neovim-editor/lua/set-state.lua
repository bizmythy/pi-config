local lines, row, byte_col = ...
local buffer = vim.g.pi_prompt_buffer
if not buffer or not vim.api.nvim_buf_is_valid(buffer) then
  return false
end

vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
if vim.api.nvim_get_current_buf() == buffer then
  vim.api.nvim_win_set_cursor(0, { row + 1, byte_col })
end
return true
