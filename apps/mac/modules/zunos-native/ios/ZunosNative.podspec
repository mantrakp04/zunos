Pod::Spec.new do |s|
  s.name           = 'ZunosNative'
  s.version        = '0.1.0'
  s.summary        = 'zunos macOS native module'
  s.description    = 'Recorder, engine process, Keychain and paths for the zunos Mac app'
  s.license        = 'UNLICENSED'
  s.author         = 'zunos'
  s.homepage       = 'https://zunos.app'
  s.platforms      = { :osx => '14.0' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'AVFoundation', 'Security', 'AppKit'
  s.source_files   = '**/*.swift'
end
