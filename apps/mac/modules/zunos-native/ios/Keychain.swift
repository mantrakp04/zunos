import Foundation
import Security

/// Generic-password items under the app's bundle id (Hexclave refresh token, etc.).
enum Keychain {
  private static let service = Bundle.main.bundleIdentifier ?? "com.zunos.app"

  private static func query(_ key: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service,
     kSecAttrAccount as String: key]
  }

  static func get(_ key: String) -> String? {
    var q = query(key)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func set(_ key: String, _ value: String) -> Bool {
    let data = Data(value.utf8)
    let status = SecItemUpdate(query(key) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var q = query(key)
      q[kSecValueData as String] = data
      q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }
    return status == errSecSuccess
  }

  static func delete(_ key: String) {
    SecItemDelete(query(key) as CFDictionary)
  }
}
