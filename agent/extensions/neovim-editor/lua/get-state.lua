local buffer = vim.g.pi_prompt_buffer
if not buffer or not vim.api.nvim_buf_is_valid(buffer) then
  return nil
end

local lines = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
local active = vim.api.nvim_get_current_buf() == buffer
local cursor = active and vim.api.nvim_win_get_cursor(0) or { 1, 0 }
local display_height = vim.api.nvim_win_text_height(0, {}).all
return { lines, cursor[1] - 1, cursor[2], active, display_height }
