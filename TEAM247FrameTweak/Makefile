TARGET := iphone:clang:16.5:15.0
ARCHS := arm64
INSTALL_TARGET_PROCESSES :=

# Rootless (Dopamine, palera1n rootless) by default.
# RootHide Theos: make package THEOS_PACKAGE_SCHEME=roothide
export THEOS_PACKAGE_SCHEME ?= rootless

include $(THEOS)/makefiles/common.mk

TWEAK_NAME := TEAM247FrameTweak

TEAM247FrameTweak_FILES := Tweak.x frame_stage.c
TEAM247FrameTweak_CFLAGS := -fobjc-arc -Wno-unused-command-line-argument
TEAM247FrameTweak_FRAMEWORKS := Foundation AVFoundation CoreMedia CoreVideo

include $(THEOS_MAKE_PATH)/tweak.mk
