# Shared across every module. Imported, not a module.

plugin_root := env_var_or_default("MAW_PLUGIN_ROOT", env_var("HOME") + "/.maw/plugins")
# where a clean tree is staged on a remote box before `maw plugin install` reads it
remote_stage := "~/.cache/maw-herdr-plugin"
