#!/usr/bin/env bash
# Compile the WinUI app's C# on Linux (no XAML compiler here): the code-behind
# is built against the real WinUI reference assemblies, with the fields the
# XAML compiler would generate stubbed from x:Name. Catches C# errors without
# a Windows round-trip; the XAML itself is only checked on Windows (CI).
set -euo pipefail
cd "$(dirname "$0")/.."
APP=$PWD/client/native/HopOn.App
S=$(mktemp -d)
trap 'rm -rf "$S"' EXIT
python3 - "$APP" "$S" <<'PY'
import re, sys, glob, os
app, out = sys.argv[1], sys.argv[2]
stubs = ["using Microsoft.UI.Xaml.Controls;", "using Microsoft.UI.Xaml.Controls.Primitives;", "using Microsoft.UI.Xaml.Shapes;", "using Microsoft.UI.Xaml.Documents;"]
for xaml in glob.glob(os.path.join(app, "*.xaml")):
    x = open(xaml).read()
    cls = re.search(r'x:Class="([\w.]+)\.(\w+)"', x)
    if not cls: continue
    ns, name = cls.groups()
    root = re.match(r'\s*(?:<\?.*?\?>\s*)?<(\w+)', x, re.S).group(1)
    fields = re.findall(r'<(\w+)\s[^>]*?x:Name="(\w+)"', x, re.S)
    stubs.append(f"namespace {ns} {{ partial class {name} {{")
    stubs += [f"    internal {t} {n} = null!;" for t, n in fields]
    stubs.append("    void InitializeComponent() {} } }")
open(os.path.join(out, "Stubs.cs"), "w").write("\n".join(stubs))
cs = "\n".join(f'    <Compile Include="{f}" />' for f in sorted(glob.glob(os.path.join(app, "*.cs"))))
pkg = re.search(r'Include="Microsoft.WindowsAppSDK.WinUI" Version="([^"]+)"', open(os.path.join(app, "HopOn.App.csproj")).read()).group(1)
open(os.path.join(out, "Check.csproj"), "w").write(f"""<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0-windows10.0.19041.0</TargetFramework>
    <TargetPlatformMinVersion>10.0.17763.0</TargetPlatformMinVersion>
    <EnableWindowsTargeting>true</EnableWindowsTargeting>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
    <RuntimeIdentifier>win-x64</RuntimeIdentifier>
    <Platform>x64</Platform>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.WindowsAppSDK.WinUI" Version="{pkg}" ExcludeAssets="build;buildTransitive" />
    <ProjectReference Include="{app}/../HopOn.Interop/HopOn.Interop.csproj" />
    <Compile Include="Stubs.cs" />
{cs}
  </ItemGroup>
</Project>
""")
PY
dotnet build "$S/Check.csproj" -v q 2>&1 | grep -E "error|warning|Error\(s\)|Warning\(s\)" | sed "s|$APP/||" | sort -u
