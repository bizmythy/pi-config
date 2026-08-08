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

local group = vim.api.nvim_create_augroup("PiEmbeddedPrompt", { clear = true })
vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI", "CursorMoved", "CursorMovedI", "ModeChanged", "BufEnter" }, {
  group = group,
  callback = function()
    vim.rpcnotify(channel, "pi_state_dirty")
  end,
})

return buffer
