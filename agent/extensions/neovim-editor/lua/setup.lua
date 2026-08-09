local channel, lines, row, byte_col = ...

-- Pi renders the active mode in its editor border. Keep Neovim's native
-- command line and messages, but omit its redundant statusline and mode row.
vim.o.laststatus = 0
vim.o.showmode = false
vim.o.ruler = false
vim.o.cmdheight = 0

local buffer = vim.api.nvim_create_buf(false, true)
vim.g.pi_prompt_buffer = buffer
vim.api.nvim_buf_set_name(buffer, "[Pi Prompt]")
vim.bo[buffer].bufhidden = "hide"
vim.bo[buffer].swapfile = false
vim.bo[buffer].undofile = false
vim.bo[buffer].filetype = "markdown"
vim.api.nvim_set_current_buf(buffer)
vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
vim.api.nvim_win_set_cursor(0, { row + 1, byte_col })
vim.api.nvim_buf_create_user_command(buffer, "PiSubmit", function()
  vim.rpcnotify(channel, "pi_submit")
end, { desc = "Submit the current prompt to Pi" })

-- Pi grows the external UI to the prompt's rendered height. Neovim normally
-- permits scrolling EOF above the bottom row, which exposes '~' filler rows and
-- can also leave one behind when the UI grows. Keep EOF bottom-aligned whenever
-- it is visible. Reassert scrolloff because user configuration may set it for
-- every window or markdown buffer.
local normalizing_viewport = false
local function normalize_viewport()
  local window = vim.fn.bufwinid(buffer)
  if window == -1 or not vim.api.nvim_win_is_valid(window) then
    return
  end

  vim.wo[window].scrolloff = 0
  if normalizing_viewport then
    return
  end

  normalizing_viewport = true
  pcall(vim.api.nvim_win_call, window, function()
    if vim.fn.line("w$") < vim.fn.line("$") then
      return
    end

    local cursor = vim.api.nvim_win_get_cursor(window)
    local last_row = vim.api.nvim_buf_line_count(buffer)
    local last_line = vim.api.nvim_buf_get_lines(buffer, last_row - 1, last_row, false)[1] or ""
    vim.api.nvim_win_set_cursor(window, { last_row, #last_line })
    vim.cmd("normal! zb")
    vim.api.nvim_win_set_cursor(window, cursor)
  end)
  normalizing_viewport = false
end
_G.pi_normalize_prompt_viewport = normalize_viewport
normalize_viewport()

local group = vim.api.nvim_create_augroup("PiEmbeddedPrompt", { clear = true })
vim.api.nvim_create_autocmd(
  { "TextChanged", "TextChangedI", "CursorMoved", "CursorMovedI", "ModeChanged", "BufEnter" },
  {
    group = group,
    callback = function()
      vim.rpcnotify(channel, "pi_state_dirty")
    end,
  }
)
vim.api.nvim_create_autocmd("WinScrolled", {
  group = group,
  callback = function()
    normalize_viewport()
    vim.rpcnotify(channel, "pi_state_dirty")
  end,
})
vim.api.nvim_create_autocmd("VimLeavePre", {
  group = group,
  once = true,
  callback = function()
    vim.rpcnotify(channel, "pi_exit")
  end,
})

vim.cmd.startinsert()
return buffer
