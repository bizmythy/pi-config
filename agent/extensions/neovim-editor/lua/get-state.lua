local buffer = vim.g.pi_prompt_buffer
if not buffer or not vim.api.nvim_buf_is_valid(buffer) then
  return nil
end

-- The UI protocol's `mode_change` event doubles as a cursor-style hint: when
-- the cursor is obscured by an overlay grid (completion popup, message, ...)
-- Neovim reports the "replace" cursor shape even though the mode did not
-- change. Never rely on redraw events for the mode; report the true mode name
-- from nvim_get_mode() so Pi's mode indicator is authoritative.
local function mode_family()
  local m = vim.api.nvim_get_mode().mode
  if m:find("^no") then
    return "operator"
  end
  if m:find("^ni") then
    return m == "niI" and "insert" or "replace"
  end
  local first = m:sub(1, 1)
  if first == "i" then
    return "insert"
  end
  if first == "R" then
    return "replace"
  end
  if first == "c" then
    return "cmdline_normal"
  end
  if first == "s" or m == "S" or m == "\19" then
    return "visual_select"
  end
  if first == "v" or m == "V" or m == "\22" then
    return "visual"
  end
  if first == "t" then
    return "terminal"
  end
  return "normal"
end

local lines = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
local active = vim.api.nvim_get_current_buf() == buffer
local cursor = active and vim.api.nvim_win_get_cursor(0) or { 1, 0 }
local display_height = vim.api.nvim_win_text_height(0, {}).all
return { lines, cursor[1] - 1, cursor[2], active, display_height, mode_family() }
